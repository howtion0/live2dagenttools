import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";

interface AgentDevice {
  id: string;
  name: string | null;
  rssi: number | null;
}

interface AudioProbe {
  path: string;
  name: string;
  bytes: number;
  formatName: string;
  durationSeconds: number | null;
  bitRate: number | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
}

interface StartAudioRequest {
  device: string;
  inputPath: string;
  mode: "watermark" | "pi";
  adapter?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const rendererRoot = path.join(appRoot, "src/renderer");
const bleAudioScript = path.join(repoRoot, "scripts/ble_audio_stream.py");

let mainWindow: BrowserWindow | undefined;
let activeSender: ChildProcess | undefined;

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 680,
    title: "Live2D ESP32 Audio Stream",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(appRoot, "src/preload.cjs"),
    },
  });
  mainWindow = win;

  win.webContents.on("console-message", (_event, _level, message) => {
    console.log(`[renderer] ${message}`);
  });
  win.webContents.on("did-fail-load", (_event, _code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description}`);
  });

  await win.loadFile(path.join(rendererRoot, "index.html"));
}

app.whenReady().then(async () => {
  installExtensionlessModuleFallback();
  await createWindow();
}).catch((error: unknown) => {
  console.error(error);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("before-quit", () => {
  stopSender();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("audio:pick", async () => {
  const options: Electron.OpenDialogOptions = {
    title: "选择要流式发送的音频",
    properties: ["openFile"],
    filters: [
      { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "webm", "mp4", "mkv"] },
      { name: "All Files", extensions: ["*"] },
    ],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return probeAudio(result.filePaths[0]);
});

ipcMain.handle("bluetooth:scan", async (_event, adapter: string | undefined) => {
  return scanDevices(adapter || "hci0", 5);
});

ipcMain.handle("audio:start", async (_event, request: StartAudioRequest) => {
  if (activeSender) {
    throw new Error("已有发送任务在运行");
  }
  if (!request.device || !request.inputPath) {
    throw new Error("device 和 inputPath 必填");
  }
  await stat(request.inputPath);
  startSender(request);
  return { ok: true };
});

ipcMain.handle("audio:stop", async () => {
  stopSender();
  return { ok: true };
});

async function probeAudio(inputPath: string): Promise<AudioProbe> {
  const info = await stat(inputPath);
  const output = await runProcessWithOutput("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    inputPath,
  ]);
  const parsed = JSON.parse(output) as {
    format?: { format_name?: string; duration?: string; bit_rate?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      width?: number;
      height?: number;
    }>;
  };
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  return {
    path: inputPath,
    name: path.basename(inputPath),
    bytes: info.size,
    formatName: parsed.format?.format_name ?? "unknown",
    durationSeconds: parseNullableNumber(parsed.format?.duration),
    bitRate: parseNullableNumber(parsed.format?.bit_rate),
    audioCodec: audio?.codec_name ?? null,
    sampleRate: parseNullableNumber(audio?.sample_rate),
    channels: audio?.channels ?? null,
    videoCodec: video?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}

function startSender(request: StartAudioRequest): void {
  const args = [
    bleAudioScript,
    "--device",
    request.device,
    "--input",
    request.inputPath,
    "--mode",
    request.mode,
    "--adapter",
    request.adapter || "hci0",
    "--progress-json",
  ];

  const sender = spawn("python3", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  activeSender = sender;
  emitAudioEvent({ event: "spawn", mode: request.mode, message: `python3 ${args.join(" ")}` });

  if (!sender.stdout || !sender.stderr) {
    throw new Error("sender stdout/stderr unavailable");
  }

  const stdout = createInterface({ input: sender.stdout });
  stdout.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      emitAudioEvent(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      emitAudioEvent({ event: "stdout", message: trimmed });
    }
  });

  const stderr = createInterface({ input: sender.stderr });
  stderr.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed) {
      emitAudioEvent({ event: "stderr", message: trimmed });
    }
  });

  sender.on("error", (error) => {
    emitAudioEvent({ event: "error", message: error.message });
  });
  sender.on("close", (code, signal) => {
    emitAudioEvent({ event: "close", code, signal });
    if (activeSender === sender) {
      activeSender = undefined;
    }
  });
}

function stopSender(): void {
  if (!activeSender) {
    return;
  }
  activeSender.kill("SIGTERM");
  activeSender = undefined;
  emitAudioEvent({ event: "stop" });
}

function emitAudioEvent(payload: Record<string, unknown>): void {
  mainWindow?.webContents.send("audio:event", payload);
}

async function scanDevices(adapter: string, seconds: number): Promise<AgentDevice[]> {
  const script = String.raw`
import dbus
import json
import time

adapter = "${escapePythonString(adapter)}"
seconds = ${Math.max(1, Math.min(30, Math.round(seconds)))}
adapter_path = "/org/bluez/" + adapter

bus = dbus.SystemBus()
manager = dbus.Interface(bus.get_object("org.bluez", "/"), "org.freedesktop.DBus.ObjectManager")
adapter_obj = bus.get_object("org.bluez", adapter_path)
adapter_iface = dbus.Interface(adapter_obj, "org.bluez.Adapter1")

try:
    adapter_iface.StartDiscovery()
except dbus.exceptions.DBusException as exc:
    if "InProgress" not in exc.get_dbus_name():
        raise

time.sleep(seconds)

try:
    adapter_iface.StopDiscovery()
except dbus.exceptions.DBusException:
    pass

devices = []
objects = manager.GetManagedObjects()
prefix = adapter_path + "/dev_"
for path, interfaces in objects.items():
    if not str(path).startswith(prefix):
        continue
    props = interfaces.get("org.bluez.Device1")
    if not props:
        continue
    address = str(props.get("Address", ""))
    if not address:
        continue
    devices.append({
        "id": address,
        "name": str(props.get("Name", props.get("Alias", ""))) or None,
        "rssi": int(props["RSSI"]) if "RSSI" in props else None,
    })

print(json.dumps(devices))
`;

  const output = await runProcessWithOutput("python3", ["-c", script]);
  return JSON.parse(output) as AgentDevice[];
}

function runProcessWithOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

function parseNullableNumber(value: string | number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapePythonString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function installExtensionlessModuleFallback(): void {
  protocol.interceptFileProtocol("file", (request, callback) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname);
    if (!path.extname(filePath)) {
      callback({ path: `${filePath}.js` });
      return;
    }
    callback({ path: filePath });
  });
}
