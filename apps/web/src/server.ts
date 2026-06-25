import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Live2DAgentClient } from "../../../packages/interaction-core/src/index.js";
import { BluezTransport } from "../../../packages/transport-bluez/src/index.js";

const PORT = Number(process.env.LIVE2D_WEB_PORT ?? 5178);
const bleAudioScript = path.resolve(process.cwd(), "scripts/ble_audio_stream.py");

interface AudioSource {
  id: string;
  name: string;
  inputPath: string;
  sourceBytes: number;
}

const audioSources = new Map<string, AudioSource>();
const publicDir = path.resolve(process.cwd(), "apps/web/src/public");
const uploadRoot = path.join(tmpdir(), "live2d-agenttools-audio");

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`Live2D Agent Tools UI: http://127.0.0.1:${PORT}`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "POST" && url.pathname === "/api/convert") {
    const source = await readBody(request);
    const name = decodeURIComponent(String(request.headers["x-file-name"] ?? "audio.mp3"));
    const audio = await storeAudioSource(name, source);
    sendJson(response, 200, {
      id: audio.id,
      name: audio.name,
      sourceBytes: audio.sourceBytes,
      format: "dynamic-ffmpeg-s16le",
      sampleRate: 16000,
      channels: 1,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/send-command") {
    const body = JSON.parse((await readBody(request)).toString("utf8")) as { device?: string; message?: string };
    if (!body.device || !body.message) {
      sendJson(response, 400, { error: "device and message are required" });
      return;
    }
    const client = new Live2DAgentClient(new BluezTransport());
    await client.connect(body.device);
    await client.sendText(body.message);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/send-audio") {
    const body = JSON.parse((await readBody(request)).toString("utf8")) as {
      device?: string;
      audioId?: string;
      mode?: "watermark" | "pi";
      metrics?: string;
      summary?: string;
    };
    if (!body.device || !body.audioId) {
      sendJson(response, 400, { error: "device and audioId are required" });
      return;
    }
    const audio = audioSources.get(body.audioId);
    if (!audio) {
      sendJson(response, 404, { error: "audio source not found" });
      return;
    }
    const result = await sendAudio(body.device, audio, {
      mode: body.mode ?? "watermark",
      metrics: body.metrics,
      summary: body.summary,
    });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    await serveStatic(url.pathname, response, request.method === "HEAD");
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

async function storeAudioSource(name: string, source: Buffer): Promise<AudioSource> {
  await mkdir(uploadRoot, { recursive: true });
  const id = randomUUID();
  const workDir = path.join(uploadRoot, id);
  await mkdir(workDir, { recursive: true });
  const inputPath = path.join(workDir, sanitizeFileName(name));
  await writeFile(inputPath, source);
  const audio = { id, name, inputPath, sourceBytes: source.length };
  audioSources.set(id, audio);
  return audio;
}

interface SendAudioResult {
  ok: boolean;
  mode: "watermark" | "pi";
  bytes: number;
  packets: number;
  durationSeconds?: number;
  averageBytesPerSecond?: number;
  statusUpdates?: number;
  finalFree?: number;
  finalFill?: number;
  finalReceived?: number;
  finalRead?: number;
  highWater?: number;
  metrics?: string;
}

interface SendAudioOptions {
  mode: "watermark" | "pi";
  metrics?: string;
  summary?: string;
}

async function sendAudio(device: string, audio: AudioSource, options: SendAudioOptions): Promise<SendAudioResult> {
  const args = [
    bleAudioScript,
    "--device",
    device,
    "--input",
    audio.inputPath,
    "--mode",
    options.mode,
  ];
  if (options.metrics) {
    args.push("--metrics", path.resolve(options.metrics));
  }
  if (options.summary) {
    args.push("--summary", path.resolve(options.summary));
  }
  const output = await runProcessWithOutput("python3", args);
  return JSON.parse(output) as SendAudioResult;
}

async function serveStatic(urlPath: string, response: ServerResponse, headOnly = false): Promise<void> {
  const fileName = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.resolve(publicDir, fileName);
  if (!filePath.startsWith(publicDir)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    response.writeHead(200, { "content-type": contentType(filePath) });
    if (headOnly) {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "not found" });
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
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

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "audio.mp3";
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}
