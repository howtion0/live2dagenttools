#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "0.1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_AUDIO_ROOTS = [
  "/run/media/howtion/thinkplus/1.8/测试音频",
  "/run/media/howtion/thinkplus/1.8",
];
const DEFAULT_MQTT_BROKER = "mqtt://192.168.11.73:1883";
const DEFAULT_DEVICE_ID = "live2d-atri";
const DEFAULT_BLE_DEVICE_NAME = "esplive2d";
const PROFILES_PATH = path.join(__dirname, "profiles.json");
const BLE_UUIDS = {
  service: "01104c21-e36a-2f97-454c-5a8a2f8f369e",
  command: "02104c21-e36a-2f97-454c-5a8a2f8f369e",
  audioWrite: "03104c21-e36a-2f97-454c-5a8a2f8f369e",
  statusAck: "04104c21-e36a-2f97-454c-5a8a2f8f369e",
};
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mka",
  ".mkv",
  ".mp3",
  ".mp4",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
]);

const tools = [
  {
    name: "list_audio_files",
    description: "List supported local audio files for ESP32 streaming.",
    inputSchema: {
      type: "object",
      properties: {
        roots: {
          type: "array",
          items: { type: "string" },
          description: "Files or directories to scan. Defaults to the workspace test-audio locations.",
        },
        recursive: { type: "boolean", default: false },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "probe_audio",
    description: "Run ffprobe on one audio file and report the stream details used before sending.",
    inputSchema: {
      type: "object",
      required: ["input"],
      properties: {
        input: { type: "string", description: "Audio file path." },
      },
    },
  },
  {
    name: "scan_ble_devices",
    description: "Use the existing live2dagenttools CLI/BlueZ transport to scan BLE devices.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSeconds: { type: "number", default: 12 },
      },
    },
  },
  {
    name: "check_mqtt_broker",
    description: "Check whether a mqtt://host:port broker accepts an MQTT 3.1.1 CONNECT.",
    inputSchema: {
      type: "object",
      required: ["broker"],
      properties: {
        broker: { type: "string", description: "MQTT broker URI, e.g. mqtt://192.168.11.73:1883." },
        timeoutSeconds: { type: "number", default: 5 },
      },
    },
  },
  {
    name: "listen_mqtt_topics",
    description: "Subscribe briefly to MQTT topics such as state, cmd, or audio/status and return observed messages.",
    inputSchema: {
      type: "object",
      required: ["broker", "topics"],
      properties: {
        broker: { type: "string", description: "MQTT broker URI." },
        topics: { type: "array", items: { type: "string" } },
        durationSeconds: { type: "number", default: 5 },
        maxMessages: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "diagnose_runtime",
    description: "Collect local network, MQTT, BlueZ, and ESP32 serial diagnostics for choosing BLE or WiFi/MQTT.",
    inputSchema: {
      type: "object",
      properties: {
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        serialPort: { type: "string", default: "/dev/ttyACM0" },
        serialSeconds: { type: "number", default: 3 },
      },
    },
  },
  {
    name: "diagnose_wifi_mqtt",
    description: "WiFi/MQTT-specific readiness diagnosis: broker checks, routes, ESP32 serial evidence, topic listen, and send command.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", default: "live2d-atri" },
        broker: { type: "string", description: "Broker to test first. Defaults to the profile MQTT broker." },
        candidateBrokers: { type: "array", items: { type: "string" } },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        audio: { type: "string", description: "Optional audio path/name to include an exact WiFi send command." },
        serialPort: { type: "string", default: "/dev/ttyACM0" },
        serialSeconds: { type: "number", default: 5 },
        listenSeconds: { type: "number", default: 5 },
        startLocalBroker: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "list_runtime_targets",
    description: "Return the known ESP32 target, BLE UUIDs, MQTT topics, audio roots, and current local readiness hints.",
    inputSchema: {
      type: "object",
      properties: {
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        includeAudio: { type: "boolean", default: true },
        audioLimit: { type: "number", default: 12 },
      },
    },
  },
  {
    name: "list_device_profiles",
    description: "List named ESP32 targets with deviceId, broker, BLE, serial, and audio-root defaults.",
    inputSchema: {
      type: "object",
      properties: {
        includeReadiness: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "validate_device_profiles",
    description: "Validate MCP/profiles.json for required fields, duplicate names, audio roots, serial paths, and broker URI shape.",
    inputSchema: {
      type: "object",
      properties: {
        includeReadiness: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "start_local_mqtt_broker",
    description: "Start a local mosquitto broker for WiFi/MQTT audio testing.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", default: "0.0.0.0" },
        port: { type: "number", default: 1883 },
        configPath: { type: "string", default: "MCP/runs/mosquitto.conf" },
        logPath: { type: "string", default: "MCP/runs/mosquitto.log" },
      },
    },
  },
  {
    name: "stop_local_mqtt_broker",
    description: "Stop the mosquitto process started from MCP/runs/mosquitto.conf, without touching unrelated brokers.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", default: 1883 },
        configPath: { type: "string", default: "MCP/runs/mosquitto.conf" },
        timeoutSeconds: { type: "number", default: 5 },
      },
    },
  },
  {
    name: "prepare_transport",
    description: "Check readiness and produce exact next steps before sending audio over BLE or WiFi/MQTT.",
    inputSchema: {
      type: "object",
      required: ["transport"],
      properties: {
        transport: { type: "string", enum: ["ble", "mqtt"] },
        input: { type: "string", description: "Optional audio file to validate." },
        bleDevice: { type: "string", description: "BLE MAC address for BLE transport." },
        adapter: { type: "string", default: "hci0" },
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        serialPort: { type: "string", default: "/dev/ttyACM0" },
        serialSeconds: { type: "number", default: 2 },
        startLocalBroker: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "play_audio_intent",
    description: "Resolve an audio selection, choose BLE/MQTT/auto, check readiness, and dry-run or send audio.",
    inputSchema: {
      type: "object",
      required: ["audio"],
      properties: {
        audio: {
          type: "string",
          description: "Audio path, basename, or substring such as ATR_b102_015.",
        },
        profile: { type: "string", default: "live2d-atri" },
        transport: { type: "string", enum: ["auto", "mqtt", "ble"], default: "auto" },
        dryRun: { type: "boolean", default: true },
        allowFallback: { type: "boolean", default: true },
        mode: { type: "string", enum: ["watermark", "pi"], default: "pi" },
        roots: { type: "array", items: { type: "string" } },
        recursive: { type: "boolean", default: false },
        bleDevice: { type: "string", description: "BLE MAC address for BLE transport." },
        adapter: { type: "string", default: "hci0" },
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        serialPort: { type: "string", default: "/dev/ttyACM0" },
        serialSeconds: { type: "number", default: 1 },
        startAckTimeout: { type: "number", default: 20 },
        drainTimeout: { type: "number", default: 180 },
        statusStallTimeout: { type: "number", default: 15 },
        timeoutSeconds: { type: "number", default: 240 },
        metrics: { type: "string", description: "Optional CSV metrics output path." },
        summary: { type: "string", description: "Optional JSON summary output path." },
      },
    },
  },
  {
    name: "smoke_test_transports",
    description: "Run a safe MCP smoke test matrix for audio selection, MQTT, BLE, serial, and optional real send.",
    inputSchema: {
      type: "object",
      properties: {
        audio: { type: "string", default: "ATR_b102_015" },
        profile: { type: "string", default: "live2d-atri" },
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        bleDevice: { type: "string", description: "BLE MAC address for BLE transport." },
        adapter: { type: "string", default: "hci0" },
        serialPort: { type: "string", default: "/dev/ttyACM0" },
        serialSeconds: { type: "number", default: 1 },
        includeLocalBroker: { type: "boolean", default: true },
        includeMqttListen: { type: "boolean", default: true },
        realSend: { type: "boolean", default: false },
        realTransport: { type: "string", enum: ["auto", "mqtt", "ble"], default: "auto" },
        timeoutSeconds: { type: "number", default: 60 },
      },
    },
  },
  {
    name: "integration_status",
    description: "Return a concise MCP integration status report with verified capabilities, blockers, and next commands.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", default: "live2d-atri" },
        audio: { type: "string", default: "ATR_b102_015" },
        includeReadiness: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "send_audio",
    description:
      "Send one audio file to the ESP32 over BLE or WiFi/MQTT using the existing ACK/backpressure sender scripts.",
    inputSchema: {
      type: "object",
      required: ["transport", "input"],
      properties: {
        transport: { type: "string", enum: ["ble", "mqtt"] },
        input: { type: "string", description: "Audio file path." },
        mode: { type: "string", enum: ["watermark", "pi"], default: "pi" },
        dryRun: { type: "boolean", default: false, description: "Return the command without transmitting audio." },
        bleDevice: { type: "string", description: "BLE MAC address. Required for BLE." },
        adapter: { type: "string", default: "hci0" },
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        startAckTimeout: { type: "number", default: 20 },
        drainTimeout: { type: "number", default: 180 },
        statusStallTimeout: { type: "number", default: 15 },
        timeoutSeconds: { type: "number", default: 240 },
        metrics: { type: "string", description: "Optional CSV metrics output path." },
        summary: { type: "string", description: "Optional JSON summary output path." },
      },
    },
  },
  {
    name: "batch_send_audio",
    description: "Send a file, directory, or file list over BLE or MQTT with ffprobe manifest generation.",
    inputSchema: {
      type: "object",
      required: ["transport", "inputs"],
      properties: {
        transport: { type: "string", enum: ["ble", "mqtt"] },
        inputs: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["watermark", "pi"], default: "pi" },
        recursive: { type: "boolean", default: false },
        dryRun: { type: "boolean", default: false },
        bleDevice: { type: "string", description: "BLE MAC address. Required for BLE." },
        adapter: { type: "string", default: "hci0" },
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        startAckTimeout: { type: "number", default: 20 },
        drainTimeout: { type: "number", default: 180 },
        statusStallTimeout: { type: "number", default: 15 },
        timeoutSeconds: { type: "number", default: 600 },
        manifest: { type: "string", description: "Optional JSON manifest path." },
        metricsDir: { type: "string", description: "Optional metrics directory." },
        summaryDir: { type: "string", description: "Optional per-file summary directory." },
      },
    },
  },
  {
    name: "read_esp32_serial",
    description: "Read ESP32 serial logs for a short window, useful for checking WiFi/BLE/MQTT state.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string", default: "/dev/ttyACM0" },
        baud: { type: "number", default: 115200 },
        durationSeconds: { type: "number", default: 8 },
      },
    },
  },
  {
    name: "send_control_command",
    description: "Send a Live2D control command over BLE, MQTT cmd topic, or raw serial.",
    inputSchema: {
      type: "object",
      required: ["transport", "command"],
      properties: {
        transport: { type: "string", enum: ["ble", "mqtt", "serial"] },
        command: {
          type: "string",
          description: "Command text, e.g. ping, wave, motion:think, speak:ATR_b102_015.",
        },
        dryRun: { type: "boolean", default: false },
        bleDevice: { type: "string", description: "BLE MAC address. Required for BLE." },
        adapter: { type: "string", default: "hci0" },
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        serialPort: { type: "string", default: "/dev/ttyACM0" },
        baud: { type: "number", default: 115200 },
        timeoutSeconds: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "switch_transport_mode",
    description: "Ask ESP32 to switch/prefer BLE or WiFi/MQTT using serial, BLE, or MQTT control, then optionally verify logs.",
    inputSchema: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["ble", "mqtt", "wifi", "auto", "cancel"] },
        method: { type: "string", enum: ["serial", "ble", "mqtt"], default: "serial" },
        command: { type: "string", description: "Optional raw command text. Defaults to mode:<mode>, or cancel for cancel." },
        dryRun: { type: "boolean", default: false },
        verify: { type: "boolean", default: true },
        bleDevice: { type: "string", description: "BLE MAC address when method=ble." },
        adapter: { type: "string", default: "hci0" },
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        serialPort: { type: "string", default: "/dev/ttyACM0" },
        baud: { type: "number", default: 115200 },
        serialSeconds: { type: "number", default: 3 },
      },
    },
  },
];

const handlers = {
  list_audio_files: listAudioFiles,
  probe_audio: probeAudio,
  scan_ble_devices: scanBleDevices,
  check_mqtt_broker: checkMqttBroker,
  listen_mqtt_topics: listenMqttTopics,
  diagnose_runtime: diagnoseRuntime,
  diagnose_wifi_mqtt: diagnoseWifiMqtt,
  list_runtime_targets: listRuntimeTargets,
  list_device_profiles: listDeviceProfiles,
  validate_device_profiles: validateDeviceProfiles,
  start_local_mqtt_broker: startLocalMqttBroker,
  stop_local_mqtt_broker: stopLocalMqttBroker,
  prepare_transport: prepareTransport,
  play_audio_intent: playAudioIntent,
  smoke_test_transports: smokeTestTransports,
  integration_status: integrationStatus,
  send_audio: sendAudio,
  batch_send_audio: batchSendAudio,
  read_esp32_serial: readEsp32Serial,
  send_control_command: sendControlCommand,
  switch_transport_mode: switchTransportMode,
};

let readBuffer = Buffer.alloc(0);
let responseFraming = "header";

process.stdin.on("data", (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk]);
  for (;;) {
    const parsed = readMessage();
    if (!parsed) {
      return;
    }
    responseFraming = parsed.framing;
    void handleMessage(parsed.message);
  }
});

process.stdin.on("end", () => process.exit(0));

function readMessage() {
  const headerEnd = readBuffer.indexOf("\r\n\r\n");
  if (headerEnd !== -1) {
    const header = readBuffer.subarray(0, headerEnd).toString("utf8");
    const match = /^Content-Length:\s*(\d+)/im.exec(header);
    if (!match) {
      throw new Error("Missing Content-Length header");
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (readBuffer.length < bodyEnd) {
      return null;
    }
    const body = readBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    readBuffer = readBuffer.subarray(bodyEnd);
    return { framing: "header", message: JSON.parse(body) };
  }

  const newline = readBuffer.indexOf("\n");
  if (newline === -1) {
    return null;
  }
  const line = readBuffer.subarray(0, newline).toString("utf8").trim();
  readBuffer = readBuffer.subarray(newline + 1);
  return line ? { framing: "line", message: JSON.parse(line) } : null;
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  if (!("id" in message)) {
    return;
  }
  try {
    const result = await dispatch(message.method, message.params || {});
    writeResponse({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    writeResponse({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function dispatch(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "live2d-agenttools-mcp", version: SERVER_VERSION },
    };
  }
  if (method === "tools/list") {
    return { tools };
  }
  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
      throw new Error(`unknown tool: ${name}`);
    }
    const data = await handlers[name](args);
    return toolResult(data);
  }
  if (method === "ping") {
    return {};
  }
  throw new Error(`unsupported method: ${method}`);
}

function writeResponse(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (responseFraming === "line") {
    process.stdout.write(`${body.toString("utf8")}\n`);
    return;
  }
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function listAudioFiles(args) {
  const roots = arrayOrDefault(args.roots, DEFAULT_AUDIO_ROOTS);
  const recursive = Boolean(args.recursive);
  const limit = clampNumber(args.limit, 1, 500, 50);
  const files = [];
  for (const root of roots) {
    const resolved = resolvePath(root);
    if (!existsSync(resolved)) {
      continue;
    }
    const stat = statSync(resolved);
    if (stat.isFile() && AUDIO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      files.push(fileInfo(resolved));
    } else if (stat.isDirectory()) {
      for (const file of await walkAudio(resolved, recursive, limit - files.length)) {
        files.push(fileInfo(file));
        if (files.length >= limit) {
          break;
        }
      }
    }
    if (files.length >= limit) {
      break;
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, count: files.length, files };
}

async function probeAudio(args) {
  const input = requireAudioPath(args.input);
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    input,
  ], { timeoutSeconds: 20 });
  const parsed = parseJson(result.stdout, "ffprobe output");
  const audio = (parsed.streams || []).find((stream) => stream.codec_type === "audio");
  return {
    ok: Boolean(audio),
    path: input,
    file: fileInfo(input),
    format: parsed.format || null,
    audioStream: audio || null,
    route: {
      decoder: "ffmpeg",
      output: "s16le",
      sampleRate: 16000,
      channels: 1,
      backpressure: "ESP32 status ACK",
    },
  };
}

async function scanBleDevices(args) {
  const timeoutSeconds = clampNumber(args.timeoutSeconds, 3, 60, 12);
  const result = await runCommand("npm", ["run", "cli", "--", "scan"], {
    cwd: REPO_ROOT,
    timeoutSeconds,
    allowFailure: true,
  });
  const diagnostics = await collectBluezDiagnostics();
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    diagnostics,
  };
}

async function checkMqttBroker(args) {
  const broker = stringOrDefault(args.broker, DEFAULT_MQTT_BROKER);
  const timeoutSeconds = clampNumber(args.timeoutSeconds, 1, 30, 5);
  const url = new URL(broker);
  if (url.protocol !== "mqtt:") {
    throw new Error("only mqtt:// broker URIs are supported");
  }
  const host = url.hostname;
  const port = Number(url.port || "1883");
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, broker, host, port, tcpConnected: false, mqttConnack: false, error: "timeout", elapsedMs: Date.now() - startedAt });
    }, timeoutSeconds * 1000);
    let received = Buffer.alloc(0);
    socket.once("connect", () => {
      const clientId = `live2d-mcp-check-${process.pid}-${Date.now()}`;
      socket.write(buildMqttConnectPacket(clientId));
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 4) {
        clearTimeout(timer);
        socket.destroy();
        const ok = received[0] === 0x20 && received[1] >= 0x02 && received[3] === 0x00;
        resolve({
          ok,
          broker,
          host,
          port,
          tcpConnected: true,
          mqttConnack: ok,
          connackHex: received.subarray(0, 8).toString("hex"),
          error: ok ? null : "invalid MQTT CONNACK",
          elapsedMs: Date.now() - startedAt,
        });
      }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (received.length === 0) {
        resolve({
          ok: false,
          broker,
          host,
          port,
          tcpConnected: true,
          mqttConnack: false,
          error: "socket closed before MQTT CONNACK",
          elapsedMs: Date.now() - startedAt,
        });
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, broker, host, port, tcpConnected: false, mqttConnack: false, error: error.message, elapsedMs: Date.now() - startedAt });
    });
  });
}

async function listenMqttTopics(args) {
  const broker = stringOrDefault(args.broker, DEFAULT_MQTT_BROKER);
  const topics = arrayOrDefault(args.topics, []).filter(Boolean);
  if (topics.length === 0) {
    throw new Error("topics is required");
  }
  const durationSeconds = clampNumber(args.durationSeconds, 1, 60, 5);
  const maxMessages = Math.trunc(clampNumber(args.maxMessages, 1, 500, 20));
  const url = new URL(broker);
  if (url.protocol !== "mqtt:") {
    throw new Error("only mqtt:// broker URIs are supported");
  }
  const host = url.hostname;
  const port = Number(url.port || "1883");
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const messages = [];
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => finish(null), durationSeconds * 1000);
    let buffer = Buffer.alloc(0);
    let connected = false;
    let subscribed = false;
    let finished = false;

    function finish(error) {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        ok: connected && subscribed && !error,
        broker,
        topics,
        durationSeconds,
        elapsedMs: Date.now() - startedAt,
        connected,
        subscribed,
        count: messages.length,
        messages,
        error: error ? String(error.message || error) : null,
      });
    }

    socket.once("connect", () => {
      socket.write(buildMqttConnectPacket(`live2d-mcp-sub-${process.pid}-${Date.now()}`));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const packet = readMqttPacket(buffer);
        if (!packet) {
          break;
        }
        buffer = buffer.subarray(packet.bytes);
        const type = packet.header >> 4;
        if (type === 2) {
          connected = packet.body.length >= 2 && packet.body[1] === 0x00;
          if (!connected) {
            finish(new Error(`MQTT CONNACK failed: ${packet.body.toString("hex")}`));
            return;
          }
          socket.write(buildMqttSubscribePacket(1, topics));
        } else if (type === 9) {
          subscribed = true;
        } else if (type === 3) {
          messages.push(parseMqttPublish(packet.body));
          if (messages.length >= maxMessages) {
            finish(null);
            return;
          }
        }
      }
    });
    socket.once("close", () => {
      if (!finished) {
        finish(connected ? null : new Error("socket closed before MQTT CONNACK"));
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

async function diagnoseRuntime(args) {
  const broker = stringOrDefault(args.broker, DEFAULT_MQTT_BROKER);
  const serialPort = stringOrDefault(args.serialPort, "/dev/ttyACM0");
  const serialSeconds = clampNumber(args.serialSeconds, 1, 20, 3);
  const [addr, route, listeners, mqtt, bluez, serial] = await Promise.all([
    runCommand("ip", ["-br", "addr"], { timeoutSeconds: 5, allowFailure: true }),
    runCommand("sh", ["-c", `ip route get ${shellQuote(new URL(broker).hostname)} 2>/dev/null || true; ip route`], { timeoutSeconds: 5, allowFailure: true }),
    runCommand("sh", ["-c", "ss -ltnp '( sport = :1883 )' 2>/dev/null || true"], { timeoutSeconds: 5, allowFailure: true }),
    checkMqttBroker({ broker, timeoutSeconds: 3 }),
    collectBluezDiagnostics(),
    readEsp32Serial({ port: serialPort, durationSeconds: serialSeconds }),
  ]);
  return {
    ok: Boolean(mqtt.ok) && bluez.bluetoothService === "active",
    broker,
    localAddresses: addr.stdout.trim(),
    routes: route.stdout.trim(),
    mqttListeners: listeners.stdout.trim(),
    mqtt,
    bluez,
    esp32Serial: serial,
    notes: [
      "WiFi/MQTT audio requires ESP32 and sender to use the same real MQTT broker.",
      "BLE audio requires BlueZ org.bluez to be active and ESP32 BLE advertising/connected.",
    ],
  };
}

async function diagnoseWifiMqtt(args) {
  const profile = await resolveDeviceProfile(args.profile);
  const profileBroker = profile?.mqttBroker || DEFAULT_MQTT_BROKER;
  const deviceId = stringOrDefault(args.deviceId, profile?.deviceId || DEFAULT_DEVICE_ID);
  const requestedBroker = stringOrDefault(args.broker, profileBroker);
  const serialPort = stringOrDefault(args.serialPort, profile?.serialPort || "/dev/ttyACM0");
  const serialSeconds = clampNumber(args.serialSeconds, 1, 30, 5);
  const listenSeconds = clampNumber(args.listenSeconds, 1, 30, 5);
  const [addr, listeners] = await Promise.all([
    runCommand("ip", ["-br", "addr"], { timeoutSeconds: 5, allowFailure: true }),
    runCommand("sh", ["-c", "ss -ltnp '( sport = :1883 )' 2>/dev/null || true"], { timeoutSeconds: 5, allowFailure: true }),
  ]);
  const suggestedLanBroker = profile?.suggestedLanBroker || suggestLanBroker(addr.stdout, requestedBroker);
  const brokerCandidates = uniqueStrings([
    requestedBroker,
    profileBroker,
    suggestedLanBroker,
    "mqtt://127.0.0.1:1883",
    ...arrayOrDefault(args.candidateBrokers, []),
  ]).filter((broker) => broker.startsWith("mqtt://"));

  let localBroker = null;
  if (args.startLocalBroker) {
    const port = Number(new URL(suggestedLanBroker || requestedBroker).port || 1883);
    localBroker = await startLocalMqttBroker({ port });
  }

  const [brokerChecks, routes, serial] = await Promise.all([
    Promise.all(brokerCandidates.map((broker) => checkMqttBroker({ broker, timeoutSeconds: 3 }))),
    Promise.all(
      brokerCandidates.map(async (broker) => {
        const host = new URL(broker).hostname;
        const route = await runCommand("sh", ["-c", `ip route get ${shellQuote(host)} 2>/dev/null || true`], {
          timeoutSeconds: 5,
          allowFailure: true,
        });
        return { broker, host, route: route.stdout.trim() };
      }),
    ),
    readEsp32Serial({ port: serialPort, durationSeconds: serialSeconds }),
  ]);
  const topics = mqttTopics(deviceId);
  const listenBroker = brokerChecks.find((check) => check.broker === requestedBroker && check.ok)?.broker
    || brokerChecks.find((check) => check.broker === suggestedLanBroker && check.ok)?.broker
    || brokerChecks.find((check) => check.ok)?.broker
    || requestedBroker;
  const topicListen = brokerChecks.some((check) => check.broker === listenBroker && check.ok)
    ? await listenMqttTopics({
        broker: listenBroker,
        topics: [topics.state, topics.audioStatus, `${topicPrefix(deviceId)}/#`],
        durationSeconds: listenSeconds,
        maxMessages: 20,
      })
    : null;

  const serialText = serial.stdout || "";
  const wifiConnected = /wifi connected/i.test(serialText);
  const wifiDisconnected = /wifi disconnected|wifi.*fail|wifi.*error/i.test(serialText);
  const mqttConnected = /mqtt connected/i.test(serialText);
  const mqttDisconnected = /mqtt disconnected|mqtt error|Error transport connect|select\(\) timeout/i.test(serialText);
  const esp32Published = Boolean(topicListen?.messages?.some((message) => message.topic === topics.state || message.topic === topics.audioStatus));
  const requestedCheck = brokerChecks.find((check) => check.broker === requestedBroker) || null;
  const selectedCheck = brokerChecks.find((check) => check.broker === listenBroker) || null;
  const readyForWifiAudio = Boolean(selectedCheck?.ok) && (mqttConnected || esp32Published) && !mqttDisconnected;
  let audio = null;
  let command = null;
  if (args.audio) {
    audio = await resolveAudioSelection({ audio: args.audio, roots: profile?.audioRoots, recursive: args.recursive });
    command = buildSingleSendCommand({
      transport: "mqtt",
      input: audio.path,
      mode: "pi",
      broker: listenBroker,
      deviceId,
      startAckTimeout: 20,
      drainTimeout: 180,
    });
  }

  const verdict = readyForWifiAudio
    ? "ready: ESP32 MQTT evidence is present and the selected broker accepts MQTT"
    : mqttDisconnected
      ? "not ready: ESP32 reaches WiFi/MQTT code but MQTT connection is failing"
      : requestedCheck && !requestedCheck.ok
        ? "not ready: requested/profile broker does not accept MQTT CONNACK"
        : selectedCheck?.ok
          ? "not ready: broker is usable, but ESP32 has not proven MQTT connection/subscription"
          : "not ready: no usable MQTT broker candidate";

  return {
    ok: readyForWifiAudio,
    readyForWifiAudio,
    verdict,
    profile: profile?.name || null,
    deviceId,
    requestedBroker,
    profileBroker,
    suggestedLanBroker,
    listenBroker,
    localBroker,
    localAddresses: addr.stdout.trim(),
    mqttListeners: listeners.stdout.trim(),
    brokerChecks,
    routes,
    topics,
    topicListen,
    esp32Evidence: {
      serialPort,
      serialSeconds,
      wifiConnected,
      wifiDisconnected,
      mqttConnected,
      mqttDisconnected,
      esp32Published,
      serial,
    },
    audio,
    command,
    nextSteps: readyForWifiAudio
      ? ["Call send_audio or play_audio_intent with transport=mqtt and dryRun=false."]
      : [
          "Use the same MQTT broker on ESP32 firmware/config and MCP sender.",
          suggestedLanBroker
            ? `For this machine, the likely LAN broker is ${suggestedLanBroker}.`
            : "Start a LAN-reachable broker and use its mqtt://<lan-ip>:1883 URI.",
          "Wait for ESP32 serial log: wifi connected ssid=FMai ip=... then mqtt connected broker=...",
          "If ESP32 only logs mqtt disconnected/Error transport connect, fix broker URI/network before sending audio.",
        ],
  };
}

async function listRuntimeTargets(args) {
  const broker = stringOrDefault(args.broker, DEFAULT_MQTT_BROKER);
  const deviceId = stringOrDefault(args.deviceId, DEFAULT_DEVICE_ID);
  const includeAudio = args.includeAudio !== false;
  const audioLimit = clampNumber(args.audioLimit, 1, 100, 12);
  const [addr, listeners, mqtt, localMqtt, bluez, audio] = await Promise.all([
    runCommand("ip", ["-br", "addr"], { timeoutSeconds: 5, allowFailure: true }),
    runCommand("sh", ["-c", "ss -ltnp '( sport = :1883 )' 2>/dev/null || true"], { timeoutSeconds: 5, allowFailure: true }),
    checkMqttBroker({ broker, timeoutSeconds: 2 }),
    checkMqttBroker({ broker: "mqtt://127.0.0.1:1883", timeoutSeconds: 1 }),
    collectBluezDiagnostics(),
    includeAudio ? listAudioFiles({ limit: audioLimit }) : Promise.resolve(null),
  ]);
  const suggestedLanBroker = suggestLanBroker(addr.stdout, broker);
  return {
    ok: true,
    defaults: {
      wifiSsid: "FMai",
      wifiPasswordConfigured: true,
      broker,
      deviceId,
      bleDeviceName: DEFAULT_BLE_DEVICE_NAME,
    },
    mqtt: {
      broker,
      deviceId,
      topics: mqttTopics(deviceId),
      brokerCheck: mqtt,
      localBrokerCheck: localMqtt,
      listeners: listeners.stdout.trim(),
      suggestedLanBroker,
    },
    ble: {
      adapter: "hci0",
      deviceName: DEFAULT_BLE_DEVICE_NAME,
      uuids: BLE_UUIDS,
      diagnostics: bluez,
    },
    serial: {
      defaultPort: "/dev/ttyACM0",
      baud: 115200,
      note: "Serial commands are sent as text plus newline; effect depends on firmware serial command parser support.",
    },
    audioRoots: DEFAULT_AUDIO_ROOTS,
    audio,
    localAddresses: addr.stdout.trim(),
  };
}

async function listDeviceProfiles(args) {
  const includeReadiness = args.includeReadiness !== false;
  const registry = await loadDeviceProfiles();
  const profiles = [];
  for (const profile of registry.profiles) {
    const topics = mqttTopics(profile.deviceId || DEFAULT_DEVICE_ID);
    let readiness = null;
    if (includeReadiness) {
      const [mqtt, bluez, serial] = await Promise.all([
        checkMqttBroker({ broker: profile.mqttBroker || DEFAULT_MQTT_BROKER, timeoutSeconds: 2 }),
        collectBluezDiagnostics(),
        profile.serialPort
          ? readEsp32Serial({ port: profile.serialPort, durationSeconds: 1 })
          : Promise.resolve(null),
      ]);
      readiness = {
        mqtt,
        bluez,
        serial,
        ready: Boolean(mqtt.ok) && bluez.bluetoothService === "active",
      };
    }
    profiles.push({
      ...profile,
      topics,
      bleUuids: BLE_UUIDS,
      readiness,
    });
  }
  return {
    ok: true,
    defaultProfile: registry.defaultProfile,
    count: profiles.length,
    profiles,
  };
}

async function validateDeviceProfiles(args) {
  const includeReadiness = Boolean(args.includeReadiness);
  const registry = await loadDeviceProfiles();
  const errors = [];
  const warnings = [];
  const names = new Set();
  const deviceIds = new Set();
  const profiles = [];

  if (!registry.defaultProfile) {
    errors.push("defaultProfile is missing");
  }

  for (const profile of registry.profiles) {
    const profileErrors = [];
    const profileWarnings = [];
    if (!profile.name) {
      profileErrors.push("name is required");
    }
    if (names.has(profile.name)) {
      profileErrors.push(`duplicate profile name: ${profile.name}`);
    }
    names.add(profile.name);
    if (!profile.deviceId) {
      profileErrors.push("deviceId is required");
    }
    if (deviceIds.has(profile.deviceId)) {
      profileWarnings.push(`duplicate deviceId: ${profile.deviceId}`);
    }
    deviceIds.add(profile.deviceId);
    try {
      const url = new URL(profile.mqttBroker);
      if (url.protocol !== "mqtt:") {
        profileErrors.push(`mqttBroker must use mqtt://: ${profile.mqttBroker}`);
      }
    } catch {
      profileErrors.push(`mqttBroker is not a valid URI: ${profile.mqttBroker}`);
    }
    if (!Array.isArray(profile.audioRoots) || profile.audioRoots.length === 0) {
      profileWarnings.push("audioRoots is empty; audio name resolution will use built-in defaults");
    } else {
      for (const root of profile.audioRoots) {
        if (!existsSync(resolvePath(root))) {
          profileWarnings.push(`audio root does not exist: ${root}`);
        }
      }
    }
    if (profile.serialPort && !existsSync(profile.serialPort)) {
      profileWarnings.push(`serial port not found now: ${profile.serialPort}`);
    }
    if (!profile.bleDevice) {
      profileWarnings.push("bleDevice is empty; BLE sends will require an explicit bleDevice");
    }

    let readiness = null;
    if (includeReadiness) {
      const [mqtt, bluez] = await Promise.all([
        checkMqttBroker({ broker: profile.mqttBroker, timeoutSeconds: 2 }),
        collectBluezDiagnostics(),
      ]);
      readiness = { mqtt, bluez };
      if (!mqtt.ok) {
        profileWarnings.push(`mqtt broker not ready now: ${mqtt.error || "unknown"}`);
      }
      if (bluez.bluetoothService !== "active") {
        profileWarnings.push(`bluetooth.service not active now: ${bluez.bluetoothService}`);
      }
    }

    for (const error of profileErrors) {
      errors.push(`${profile.name || "<unnamed>"}: ${error}`);
    }
    for (const warning of profileWarnings) {
      warnings.push(`${profile.name || "<unnamed>"}: ${warning}`);
    }
    profiles.push({
      name: profile.name,
      deviceId: profile.deviceId,
      errors: profileErrors,
      warnings: profileWarnings,
      readiness,
    });
  }

  if (registry.defaultProfile && !registry.profiles.some((profile) => profile.name === registry.defaultProfile)) {
    errors.push(`defaultProfile does not match any profile name: ${registry.defaultProfile}`);
  }

  return {
    ok: errors.length === 0,
    profilePath: PROFILES_PATH,
    defaultProfile: registry.defaultProfile,
    profileCount: registry.profiles.length,
    errors,
    warnings,
    profiles,
  };
}

async function startLocalMqttBroker(args) {
  const host = stringOrDefault(args.host, "0.0.0.0");
  const port = Math.trunc(clampNumber(args.port, 1, 65535, 1883));
  const configPath = resolvePath(stringOrDefault(args.configPath, "MCP/runs/mosquitto.conf"));
  const logPath = resolvePath(stringOrDefault(args.logPath, "MCP/runs/mosquitto.log"));
  const existing = await checkMqttBroker({ broker: `mqtt://127.0.0.1:${port}`, timeoutSeconds: 1 });
  if (existing.ok) {
    return { ok: true, alreadyRunning: true, broker: `mqtt://127.0.0.1:${port}` };
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(path.dirname(logPath), { recursive: true });
  const config = [
    `listener ${port} ${host}`,
    "allow_anonymous true",
    "persistence false",
    `log_dest file ${logPath}`,
    "log_type error",
    "log_type warning",
    "log_type notice",
    "",
  ].join("\n");
  await writeFile(configPath, config, "utf8");
  const child = spawn("mosquitto", ["-c", configPath], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await sleep(500);
  const check = await checkMqttBroker({ broker: `mqtt://127.0.0.1:${port}`, timeoutSeconds: 2 });
  return {
    ok: Boolean(check.ok),
    broker: `mqtt://127.0.0.1:${port}`,
    lanBrokerHint: `mqtt://<this-machine-lan-ip>:${port}`,
    pid: child.pid,
    configPath,
    logPath,
    check,
  };
}

async function stopLocalMqttBroker(args) {
  const port = Math.trunc(clampNumber(args.port, 1, 65535, 1883));
  const configPath = resolvePath(stringOrDefault(args.configPath, "MCP/runs/mosquitto.conf"));
  const timeoutSeconds = clampNumber(args.timeoutSeconds, 1, 30, 5);
  const listener = await runCommand("sh", ["-c", `ss -ltnp '( sport = :${port} )' 2>/dev/null || true`], {
    timeoutSeconds: 5,
    allowFailure: true,
  });
  const pids = [...listener.stdout.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
  const candidates = [];
  for (const pid of new Set(pids)) {
    const cmdline = await readProcCmdline(pid);
    const managed = cmdline.includes("mosquitto") && cmdline.includes(configPath);
    candidates.push({ pid, cmdline, managed });
  }
  const managed = candidates.filter((candidate) => candidate.managed);
  if (managed.length === 0) {
    return {
      ok: false,
      stopped: false,
      port,
      configPath,
      candidates,
      listener: listener.stdout.trim(),
      error: candidates.length === 0 ? "no listener found" : "listener is not the MCP-managed mosquitto process",
    };
  }
  for (const candidate of managed) {
    process.kill(candidate.pid, "SIGTERM");
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  let check = await checkMqttBroker({ broker: `mqtt://127.0.0.1:${port}`, timeoutSeconds: 1 });
  while (check.ok && Date.now() < deadline) {
    await sleep(250);
    check = await checkMqttBroker({ broker: `mqtt://127.0.0.1:${port}`, timeoutSeconds: 1 });
  }
  return {
    ok: !check.ok,
    stopped: !check.ok,
    port,
    configPath,
    stoppedPids: managed.map((candidate) => candidate.pid),
    check,
  };
}

async function prepareTransport(args) {
  const transport = requireTransport(args.transport);
  const input = args.input ? requireAudioPath(args.input) : null;
  const serialPort = stringOrDefault(args.serialPort, "/dev/ttyACM0");
  const serialSeconds = clampNumber(args.serialSeconds, 1, 20, 2);
  if (transport === "mqtt") {
    const broker = stringOrDefault(args.broker, DEFAULT_MQTT_BROKER);
    const deviceId = stringOrDefault(args.deviceId, DEFAULT_DEVICE_ID);
    let localBroker = null;
    if (args.startLocalBroker) {
      localBroker = await startLocalMqttBroker({ port: new URL(broker).port || 1883 });
    }
    const [mqtt, diag] = await Promise.all([
      checkMqttBroker({ broker, timeoutSeconds: 3 }),
      diagnoseRuntime({ broker, serialPort, serialSeconds }),
    ]);
    const suggestedLanBroker = suggestLanBroker(diag.localAddresses, broker);
    const esp32MqttEvidence = {
      connected: serialMentions(diag.esp32Serial, "mqtt connected"),
      disconnected: serialMentions(diag.esp32Serial, "mqtt disconnected") || serialMentions(diag.esp32Serial, "mqtt error"),
      wifiConnected: serialMentions(diag.esp32Serial, "wifi connected"),
    };
    const ready = Boolean(mqtt.ok);
    const command = input
      ? buildSingleSendCommand({
          transport: "mqtt",
          input,
          mode: "pi",
          broker,
          deviceId,
          startAckTimeout: 20,
          drainTimeout: 180,
        })
      : null;
    return {
      ok: ready,
      ready,
      transport: "mqtt",
      input,
      broker,
      deviceId,
      mqtt,
      esp32MqttEvidence,
      localBroker,
      suggestedLanBroker,
      esp32Serial: diag.esp32Serial,
      command,
      nextSteps: mqtt.ok
        ? [
            "Press ESP32 PWR to enter connection mode if it is not already connected.",
            "Call send_audio with this broker and deviceId; the ESP32 START/status ACK proves subscription.",
            "If send_audio times out waiting for START ACK, check ESP32 serial for mqtt connected/disconnected.",
          ]
        : [
            "Use a real MQTT broker that returns CONNACK.",
            suggestedLanBroker
              ? `If using this machine, configure ESP32 broker to ${suggestedLanBroker} and start_local_mqtt_broker.`
              : "Start a local broker and point ESP32 firmware/config to this machine LAN IP.",
          ],
    };
  }

  const bleDevice = stringOrDefault(args.bleDevice, "");
  const adapter = stringOrDefault(args.adapter, "hci0");
  const bluez = await collectBluezDiagnostics();
  const ready = bluez.bluetoothService === "active" && bluez.adapters.includes(adapter) && Boolean(bleDevice);
  const command =
    input && bleDevice
      ? buildSingleSendCommand({
          transport: "ble",
          input,
          mode: "pi",
          bleDevice,
          adapter,
          startAckTimeout: 20,
          drainTimeout: 180,
        })
      : null;
  return {
    ok: ready,
    ready,
    transport: "ble",
    input,
    bleDevice,
    adapter,
    bluez,
    command,
    nextSteps: ready
      ? [
          "Press ESP32 PWR to enter connection mode if needed.",
          "Call send_audio with transport=ble, bleDevice, and adapter.",
        ]
      : [
          bluez.bluetoothService === "active" ? "Bluetooth service is active." : "Start bluetooth.service with system privileges.",
          bleDevice ? "BLE device id is provided." : "Scan or provide the ESP32 BLE MAC address.",
          bluez.adapters.includes(adapter) ? `${adapter} exists.` : `Adapter ${adapter} was not found.`,
        ],
  };
}

async function playAudioIntent(args) {
  const audio = stringOrDefault(args.audio, "");
  if (!audio) {
    throw new Error("audio is required");
  }
  const profile = await resolveDeviceProfile(args.profile);
  const resolvedAudio = await resolveAudioSelection({
    audio,
    roots: args.roots || profile?.audioRoots,
    recursive: args.recursive,
  });
  const requestedTransport = requireIntentTransport(stringOrDefault(args.transport, "auto"));
  const allowFallback = args.allowFallback !== false;
  const dryRun = args.dryRun !== false;
  const mode = args.mode === "watermark" ? "watermark" : "pi";
  const broker = stringOrDefault(args.broker, profile?.mqttBroker || DEFAULT_MQTT_BROKER);
  const deviceId = stringOrDefault(args.deviceId, profile?.deviceId || DEFAULT_DEVICE_ID);
  const bleDevice = stringOrDefault(args.bleDevice, profile?.bleDevice || "");
  const adapter = stringOrDefault(args.adapter, profile?.adapter || "hci0");
  const serialPort = stringOrDefault(args.serialPort, profile?.serialPort || "/dev/ttyACM0");
  const serialSeconds = clampNumber(args.serialSeconds, 1, 20, 1);

  const transports =
    requestedTransport === "auto"
      ? ["mqtt", "ble"]
      : allowFallback
        ? requestedTransport === "mqtt"
          ? ["mqtt", "ble"]
          : ["ble", "mqtt"]
        : [requestedTransport];
  const readiness = {};
  for (const transport of transports) {
    readiness[transport] = await prepareTransport({
      transport,
      input: resolvedAudio.path,
      bleDevice,
      adapter,
      broker,
      deviceId,
      serialPort,
      serialSeconds,
    });
  }
  const selectedTransport = chooseReadyTransport(transports, readiness);
  const selectedReadiness = selectedTransport ? readiness[selectedTransport] : null;
  const sendArgs = {
    transport: selectedTransport || transports[0],
    input: resolvedAudio.path,
    mode,
    dryRun,
    bleDevice,
    adapter,
    broker,
    deviceId,
    startAckTimeout: args.startAckTimeout,
    drainTimeout: args.drainTimeout,
    timeoutSeconds: args.timeoutSeconds,
    metrics: args.metrics,
    summary: args.summary,
  };
  const canSend = Boolean(selectedTransport && selectedReadiness?.ready);
  const send = canSend
    ? await sendAudio(sendArgs)
    : dryRun
      ? {
          ok: true,
          dryRun: true,
          transport: transports[0],
          command: readiness[transports[0]]?.command || null,
          note: "No ready transport; this is a prepared dry-run result, not a send attempt.",
        }
      : null;
  return {
    ok: Boolean(send?.ok) && (dryRun || canSend),
    dryRun,
    requestedTransport,
    selectedTransport: selectedTransport || null,
    canSend,
    selectionReason: selectedTransport
      ? `${selectedTransport} readiness passed`
      : "No requested transport is ready; returning prepared commands and next steps without sending.",
    profile: profile?.name || null,
    audio: resolvedAudio,
    readiness,
    send,
    nextSteps: selectedTransport
      ? selectedReadiness.nextSteps
      : flattenNextSteps(transports, readiness),
  };
}

async function smokeTestTransports(args) {
  const audio = stringOrDefault(args.audio, "ATR_b102_015");
  const profile = await resolveDeviceProfile(args.profile);
  const broker = stringOrDefault(args.broker, profile?.mqttBroker || DEFAULT_MQTT_BROKER);
  const deviceId = stringOrDefault(args.deviceId, profile?.deviceId || DEFAULT_DEVICE_ID);
  const bleDevice = stringOrDefault(args.bleDevice, profile?.bleDevice || "");
  const adapter = stringOrDefault(args.adapter, profile?.adapter || "hci0");
  const serialPort = stringOrDefault(args.serialPort, profile?.serialPort || "/dev/ttyACM0");
  const serialSeconds = clampNumber(args.serialSeconds, 1, 20, 1);
  const includeLocalBroker = args.includeLocalBroker !== false;
  const includeMqttListen = args.includeMqttListen !== false;
  const realSend = Boolean(args.realSend);
  const realTransport = requireIntentTransport(stringOrDefault(args.realTransport, "auto"));

  const resolvedAudio = await resolveAudioSelection({ audio, roots: args.roots || profile?.audioRoots, recursive: args.recursive });
  const [targets, mqttPrep, blePrep, serial] = await Promise.all([
    listRuntimeTargets({ broker, deviceId, audioLimit: 5 }),
    prepareTransport({ transport: "mqtt", input: resolvedAudio.path, broker, deviceId, serialPort, serialSeconds }),
    prepareTransport({ transport: "ble", input: resolvedAudio.path, bleDevice, adapter, serialPort, serialSeconds }),
    readEsp32Serial({ port: serialPort, durationSeconds: serialSeconds }),
  ]);
  const localBroker = includeLocalBroker ? await checkMqttBroker({ broker: "mqtt://127.0.0.1:1883", timeoutSeconds: 2 }) : null;
  const mqttListen =
    includeMqttListen && localBroker?.ok
      ? await listenMqttTopics({
          broker: "mqtt://127.0.0.1:1883",
          topics: [mqttTopics(deviceId).state, mqttTopics(deviceId).audioStatus],
          durationSeconds: 1,
          maxMessages: 2,
        })
      : null;
  const dryRunIntent = await playAudioIntent({
    audio: resolvedAudio.path,
    transport: "auto",
    dryRun: true,
    allowFallback: true,
    broker,
    deviceId,
    bleDevice,
    adapter,
    serialPort,
    serialSeconds,
  });
  const realSendResult = realSend
    ? await playAudioIntent({
        audio: resolvedAudio.path,
        transport: realTransport,
        dryRun: false,
        allowFallback: realTransport === "auto",
        broker,
        deviceId,
        bleDevice,
        adapter,
        serialPort,
        serialSeconds,
        timeoutSeconds: args.timeoutSeconds,
      })
    : null;
  const checks = [
    smokeCheck("audio_resolved", "pass", `Resolved ${resolvedAudio.name}`, resolvedAudio),
    smokeCheck(
      "configured_mqtt_broker",
      mqttPrep.mqtt?.ok ? "pass" : "fail",
      mqttPrep.mqtt?.ok ? "Configured broker returns MQTT CONNACK." : `Configured broker is not MQTT-ready: ${mqttPrep.mqtt?.error || "unknown"}`,
      mqttPrep.mqtt,
    ),
    smokeCheck(
      "mqtt_ready_for_esp32_audio",
      mqttPrep.ready ? "pass" : "fail",
      mqttPrep.ready ? "ESP32 appears connected to MQTT." : "ESP32 MQTT audio readiness is not proven.",
      { ready: mqttPrep.ready, nextSteps: mqttPrep.nextSteps },
    ),
    smokeCheck(
      "ble_ready_for_audio",
      blePrep.ready ? "pass" : "fail",
      blePrep.ready ? "BLE transport appears ready." : "BLE audio readiness is not proven.",
      { ready: blePrep.ready, nextSteps: blePrep.nextSteps },
    ),
    smokeCheck(
      "serial_read",
      serial.ok ? "pass" : "warn",
      serial.ok ? "Serial read path works." : "Serial read did not complete cleanly.",
      { port: serial.port, code: serial.code, stdout: serial.stdout },
    ),
  ];
  if (localBroker) {
    checks.push(
      smokeCheck(
        "local_broker",
        localBroker.ok ? "pass" : "warn",
        localBroker.ok ? "Local MQTT broker accepts CONNACK." : `Local MQTT broker not ready: ${localBroker.error || "unknown"}`,
        localBroker,
      ),
    );
  }
  if (mqttListen) {
    checks.push(
      smokeCheck(
        "local_mqtt_subscribe",
        mqttListen.connected && mqttListen.subscribed ? "pass" : "warn",
        mqttListen.connected && mqttListen.subscribed ? "Local MQTT subscribe path works." : "Local MQTT subscribe path did not become ready.",
        mqttListen,
      ),
    );
  }
  if (realSendResult) {
    checks.push(
      smokeCheck(
        "real_audio_send",
        realSendResult.ok && realSendResult.canSend ? "pass" : "fail",
        realSendResult.ok && realSendResult.canSend ? "Real audio send completed." : "Real audio send was not completed.",
        realSendResult,
      ),
    );
  }
  const readyForRealAudio = Boolean(mqttPrep.ready || blePrep.ready);
  return {
    ok: checks.every((check) => check.status !== "fail") && (!realSend || Boolean(realSendResult?.ok)),
    readyForRealAudio,
    realSendAttempted: realSend,
    audio: resolvedAudio,
    profile: profile?.name || null,
    broker,
    deviceId,
    bleDevice,
    adapter,
    checks,
    targets,
    mqttPrep,
    blePrep,
    dryRunIntent,
    realSendResult,
    nextSteps: readyForRealAudio
      ? ["Call play_audio_intent with dryRun=false for the ready transport."]
      : flattenNextSteps(["mqtt", "ble"], { mqtt: mqttPrep, ble: blePrep }),
  };
}

async function integrationStatus(args) {
  const profileName = stringOrDefault(args.profile, "live2d-atri");
  const audio = stringOrDefault(args.audio, "ATR_b102_015");
  const includeReadiness = args.includeReadiness !== false;
  const [profiles, validation, smoke] = await Promise.all([
    listDeviceProfiles({ includeReadiness: false }),
    validateDeviceProfiles({ includeReadiness }),
    smokeTestTransports({
      profile: profileName,
      audio,
      includeLocalBroker: true,
      includeMqttListen: true,
      realSend: false,
    }),
  ]);
  const failedChecks = (smoke.checks || []).filter((check) => check.status === "fail");
  const passedChecks = (smoke.checks || []).filter((check) => check.status === "pass");
  return {
    ok: validation.ok && smoke.readyForRealAudio,
    mcpReady: validation.ok,
    claudeConfig: {
      configPath: path.join(REPO_ROOT, ".mcp.json"),
      serverCommand: ["node", path.join(REPO_ROOT, "MCP", "server.js")],
      smokeCommand: "npm run mcp:claude-smoke",
    },
    profile: profileName,
    audio,
    profileValidation: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    smoke: {
      ok: smoke.ok,
      readyForRealAudio: smoke.readyForRealAudio,
      passed: passedChecks.map((check) => check.name),
      failed: failedChecks.map((check) => ({ name: check.name, message: check.message })),
      nextSteps: smoke.nextSteps,
    },
    verifiedCapabilities: [
      "MCP server initializes and exposes tools over stdio.",
      "Claude can call the project MCP server through .mcp.json.",
      "Audio files can be resolved by path, basename, or substring.",
      "Device profiles provide deviceId, MQTT, BLE, serial, and audio-root defaults.",
      "MQTT broker CONNECT/CONNACK, publish, subscribe, and topic parsing are implemented.",
      "BLE readiness and BlueZ diagnostics are reported.",
      "Serial read/write control paths are exposed with effect verification.",
      "High-level play_audio_intent can choose auto/mqtt/ble and dry-run commands.",
      "Smoke tests distinguish MCP/tooling health from real transport readiness.",
    ],
    blockers: failedChecks.map((check) => check.message),
    commands: {
      profileCheck: "npm run mcp:profiles",
      profileReadinessCheck: "MCP_PROFILE_READINESS=1 npm run mcp:profiles",
      localSmoke: "npm run mcp:smoke",
      claudeSmoke: "npm run mcp:claude-smoke",
      typecheck: "npm run typecheck",
    },
    profiles: profiles.profiles,
  };
}

async function sendAudio(args) {
  const input = requireAudioPath(args.input);
  const transport = requireTransport(args.transport);
  const mode = args.mode === "watermark" ? "watermark" : "pi";
  const command = buildSingleSendCommand({ ...args, input, transport, mode });
  if (args.dryRun) {
    return { ok: true, dryRun: true, command };
  }
  const result = await runCommand(command[0], command.slice(1), {
    cwd: REPO_ROOT,
    timeoutSeconds: clampNumber(args.timeoutSeconds, 10, 3600, 240),
    allowFailure: true,
  });
  return commandResult(result, command);
}

async function batchSendAudio(args) {
  const transport = requireTransport(args.transport);
  const inputs = arrayOrDefault(args.inputs, []);
  if (inputs.length === 0) {
    throw new Error("inputs is required");
  }
  const mode = args.mode === "watermark" ? "watermark" : "pi";
  const command = [pythonCommand(), path.join(REPO_ROOT, "scripts/audio_batch_stream.py")];
  command.push("--transport", transport, "--mode", mode);
  if (transport === "mqtt") {
    command.push("--broker", stringOrDefault(args.broker, DEFAULT_MQTT_BROKER));
    command.push("--device-id", stringOrDefault(args.deviceId, DEFAULT_DEVICE_ID));
  } else {
    const device = stringOrDefault(args.bleDevice, "");
    if (!device) {
      throw new Error("bleDevice is required when transport=ble");
    }
    command.push("--device", device, "--adapter", stringOrDefault(args.adapter, "hci0"));
  }
  if (args.recursive) {
    command.push("--recursive");
  }
  command.push("--start-ack-timeout", String(clampNumber(args.startAckTimeout, 1, 300, 20)));
  command.push("--drain-timeout", String(clampNumber(args.drainTimeout, 1, 1800, 180)));
  if (transport === "mqtt") {
    command.push("--status-stall-timeout", String(clampNumber(args.statusStallTimeout, 0, 600, 15)));
  }
  if (args.manifest) {
    command.push("--manifest", resolvePath(args.manifest));
  }
  if (args.metricsDir) {
    command.push("--metrics-dir", resolvePath(args.metricsDir));
  }
  if (args.summaryDir) {
    command.push("--summary-dir", resolvePath(args.summaryDir));
  }
  for (const input of inputs) {
    command.push(resolvePath(input));
  }
  if (args.dryRun) {
    return { ok: true, dryRun: true, command };
  }
  const result = await runCommand(command[0], command.slice(1), {
    cwd: REPO_ROOT,
    timeoutSeconds: clampNumber(args.timeoutSeconds, 10, 7200, 600),
    allowFailure: true,
  });
  return commandResult(result, command);
}

async function readEsp32Serial(args) {
  const port = stringOrDefault(args.port, "/dev/ttyACM0");
  const baud = Math.trunc(clampNumber(args.baud, 9600, 921600, 115200));
  const durationSeconds = clampNumber(args.durationSeconds, 1, 60, 8);
  if (!existsSync(port)) {
    throw new Error(`serial port not found: ${port}`);
  }
  await runCommand("stty", ["-F", port, String(baud), "raw", "-echo"], { timeoutSeconds: 5, allowFailure: true });
  const result = await runCommand("timeout", [`${durationSeconds}s`, "cat", port], {
    timeoutSeconds: durationSeconds + 3,
    allowFailure: true,
  });
  return {
    ok: result.code === 0 || result.code === 124,
    port,
    baud,
    durationSeconds,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  };
}

async function sendControlCommand(args) {
  const transport = requireControlTransport(args.transport);
  const commandText = stringOrDefault(args.command, "").trim();
  if (!commandText) {
    throw new Error("command is required");
  }
  if (transport === "ble") {
    const device = stringOrDefault(args.bleDevice, "");
    if (!device) {
      throw new Error("bleDevice is required when transport=ble");
    }
    const command = ["npm", "run", "cli", "--", "send", "--device", device, "--message", commandText];
    if (args.dryRun) {
      return { ok: true, dryRun: true, command };
    }
    const result = await runCommand(command[0], command.slice(1), {
      cwd: REPO_ROOT,
      timeoutSeconds: clampNumber(args.timeoutSeconds, 5, 120, 20),
      allowFailure: true,
    });
    return commandResult(result, command);
  }
  if (transport === "mqtt") {
    const broker = stringOrDefault(args.broker, DEFAULT_MQTT_BROKER);
    const deviceId = stringOrDefault(args.deviceId, DEFAULT_DEVICE_ID);
    const topic = `live2d/${deviceId}/cmd`;
    if (args.dryRun) {
      return { ok: true, dryRun: true, broker, topic, payload: commandText };
    }
    return await publishMqttMessage({
      broker,
      topic,
      payload: Buffer.from(commandText, "utf8"),
      timeoutSeconds: clampNumber(args.timeoutSeconds, 3, 60, 20),
    });
  }
  const serialPort = stringOrDefault(args.serialPort, "/dev/ttyACM0");
  const baud = Math.trunc(clampNumber(args.baud, 9600, 921600, 115200));
  const payload = `${commandText}\n`;
  if (args.dryRun) {
    return { ok: true, dryRun: true, serialPort, baud, payload };
  }
  if (!existsSync(serialPort)) {
    throw new Error(`serial port not found: ${serialPort}`);
  }
  await runCommand("stty", ["-F", serialPort, String(baud), "raw", "-echo"], { timeoutSeconds: 5, allowFailure: true });
  await writeFile(serialPort, payload, "utf8");
  return {
    ok: true,
    transport: "serial",
    serialPort,
    baud,
    payload,
    note: "Serial write completed. Firmware must implement a serial command parser for this to have an effect.",
  };
}

async function switchTransportMode(args) {
  const mode = requireSwitchMode(args.mode);
  const method = requireControlTransport(stringOrDefault(args.method, "serial"));
  const commandText = stringOrDefault(args.command, defaultSwitchCommand(mode));
  const serialSeconds = clampNumber(args.serialSeconds, 1, 20, 3);
  const controlArgs = {
    transport: method,
    command: commandText,
    dryRun: Boolean(args.dryRun),
    bleDevice: args.bleDevice,
    adapter: args.adapter,
    broker: args.broker,
    deviceId: args.deviceId,
    serialPort: args.serialPort,
    baud: args.baud,
    timeoutSeconds: args.timeoutSeconds,
  };
  const sent = await sendControlCommand(controlArgs);
  const verify = args.verify !== false && !args.dryRun;
  const diagnostics = verify
    ? await diagnoseRuntime({
        broker: stringOrDefault(args.broker, DEFAULT_MQTT_BROKER),
        serialPort: stringOrDefault(args.serialPort, "/dev/ttyACM0"),
        serialSeconds,
      })
    : null;
  const evidence = diagnostics ? modeEvidence(mode, diagnostics) : null;
  return {
    ok: Boolean(sent.ok) && (!verify || Boolean(evidence?.matched)),
    sentOk: Boolean(sent.ok),
    effectVerified: verify ? Boolean(evidence?.matched) : null,
    mode,
    method,
    command: commandText,
    sent,
    evidence,
    diagnostics,
    commandCandidates: switchCommandCandidates(mode),
    notes: [
      "MCP can send the switch/control request over serial, BLE, or MQTT.",
      "A real transport switch is only proven when ESP32 logs/state show the requested mode.",
      "If firmware has no serial command parser, serial writes complete but do not change mode.",
    ],
  };
}

async function publishMqttMessage({ broker, topic, payload, timeoutSeconds }) {
  const url = new URL(broker);
  if (url.protocol !== "mqtt:") {
    throw new Error("only mqtt:// broker URIs are supported");
  }
  const host = url.hostname;
  const port = Number(url.port || "1883");
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, broker, topic, error: "timeout", elapsedMs: Date.now() - startedAt });
    }, timeoutSeconds * 1000);
    let phase = "connect";
    let received = Buffer.alloc(0);
    socket.once("connect", () => {
      socket.write(buildMqttConnectPacket(`live2d-mcp-cmd-${process.pid}-${Date.now()}`));
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (phase === "connect" && received.length >= 4) {
        const ok = received[0] === 0x20 && received[1] >= 0x02 && received[3] === 0x00;
        if (!ok) {
          clearTimeout(timer);
          socket.destroy();
          resolve({ ok: false, broker, topic, error: "invalid MQTT CONNACK", connackHex: received.toString("hex") });
          return;
        }
        phase = "publish";
        socket.write(buildMqttPublishPacket(topic, payload));
        socket.end(buildMqttDisconnectPacket());
      }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve({
        ok: phase === "publish",
        broker,
        topic,
        bytes: payload.length,
        payload: payload.toString("utf8"),
        elapsedMs: Date.now() - startedAt,
        error: phase === "publish" ? null : "socket closed before MQTT CONNACK",
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, broker, topic, error: error.message, elapsedMs: Date.now() - startedAt });
    });
  });
}

async function collectBluezDiagnostics() {
  const [service, adapters, rfkill] = await Promise.all([
    runCommand("systemctl", ["is-active", "bluetooth"], { timeoutSeconds: 5, allowFailure: true }),
    runCommand("sh", ["-c", "ls -1 /sys/class/bluetooth 2>/dev/null || true"], { timeoutSeconds: 5, allowFailure: true }),
    runCommand("sh", ["-c", "rfkill list bluetooth 2>/dev/null || true"], { timeoutSeconds: 5, allowFailure: true }),
  ]);
  return {
    bluetoothService: service.stdout.trim() || service.stderr.trim() || `exit ${service.code}`,
    adapters: adapters.stdout.trim().split(/\r?\n/).filter(Boolean),
    rfkill: rfkill.stdout.trim(),
  };
}

function buildSingleSendCommand(args) {
  const command = [
    pythonCommand(),
    path.join(REPO_ROOT, "scripts", args.transport === "mqtt" ? "mqtt_audio_stream.py" : "ble_audio_stream.py"),
  ];
  if (args.transport === "mqtt") {
    command.push("--broker", stringOrDefault(args.broker, DEFAULT_MQTT_BROKER));
    command.push("--device-id", stringOrDefault(args.deviceId, DEFAULT_DEVICE_ID));
  } else {
    const device = stringOrDefault(args.bleDevice, "");
    if (!device) {
      throw new Error("bleDevice is required when transport=ble");
    }
    command.push("--device", device, "--adapter", stringOrDefault(args.adapter, "hci0"));
  }
  command.push(
    "--input",
    args.input,
    "--mode",
    args.mode,
    "--start-ack-timeout",
    String(clampNumber(args.startAckTimeout, 1, 300, 20)),
    "--drain-timeout",
    String(clampNumber(args.drainTimeout, 1, 1800, 180)),
  );
  if (args.transport === "mqtt") {
    command.push("--status-stall-timeout", String(clampNumber(args.statusStallTimeout, 0, 600, 15)));
  }
  if (args.metrics) {
    command.push("--metrics", resolvePath(args.metrics));
  }
  if (args.summary) {
    command.push("--summary", resolvePath(args.summary));
  }
  return command;
}

function commandResult(result, command) {
  let parsedSummary = null;
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length > 0) {
    try {
      parsedSummary = JSON.parse(lines[lines.length - 1]);
    } catch {
      parsedSummary = null;
    }
  }
  return {
    ok: result.code === 0 && (!parsedSummary || parsedSummary.ok !== false),
    command,
    code: result.code,
    summary: parsedSummary,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function walkAudio(root, recursive, limit) {
  const output = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      output.push(fullPath);
    } else if (recursive && entry.isDirectory()) {
      output.push(...(await walkAudio(fullPath, recursive, limit - output.length)));
    }
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function fileInfo(filePath) {
  const stat = statSync(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function requireAudioPath(value) {
  const resolved = resolvePath(stringOrDefault(value, ""));
  if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`audio file not found: ${value}`);
  }
  if (!AUDIO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new Error(`unsupported audio file extension: ${resolved}`);
  }
  return resolved;
}

function requireTransport(value) {
  if (value !== "ble" && value !== "mqtt") {
    throw new Error("transport must be ble or mqtt");
  }
  return value;
}

function requireIntentTransport(value) {
  if (value !== "auto" && value !== "ble" && value !== "mqtt") {
    throw new Error("transport must be auto, ble, or mqtt");
  }
  return value;
}

function requireControlTransport(value) {
  if (value !== "ble" && value !== "mqtt" && value !== "serial") {
    throw new Error("transport must be ble, mqtt, or serial");
  }
  return value;
}

function requireSwitchMode(value) {
  if (value !== "ble" && value !== "mqtt" && value !== "wifi" && value !== "auto" && value !== "cancel") {
    throw new Error("mode must be ble, mqtt, wifi, auto, or cancel");
  }
  return value;
}

function resolvePath(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (raw.startsWith("~")) {
    return path.resolve(os.homedir(), raw.slice(1));
  }
  return path.resolve(REPO_ROOT, raw);
}

function stringOrDefault(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function arrayOrDefault(value, fallback) {
  return Array.isArray(value) ? value.map(String) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serialMentions(serial, needle) {
  const text = typeof serial === "string" ? serial : JSON.stringify(serial || {});
  return text.toLowerCase().includes(needle.toLowerCase());
}

function mqttTopics(deviceId) {
  return {
    command: `live2d/${deviceId}/cmd`,
    audioIn: `live2d/${deviceId}/audio/in`,
    audioStatus: `live2d/${deviceId}/audio/status`,
    state: `live2d/${deviceId}/state`,
  };
}

function topicPrefix(deviceId) {
  return `live2d/${deviceId}`;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function defaultSwitchCommand(mode) {
  if (mode === "cancel") {
    return "cancel";
  }
  return `mode:${mode}`;
}

function switchCommandCandidates(mode) {
  if (mode === "cancel") {
    return ["cancel", "audio:cancel", "stop"];
  }
  if (mode === "wifi" || mode === "mqtt") {
    return ["mode:mqtt", "mode:wifi", "transport:mqtt", "wifi", "mqtt"];
  }
  if (mode === "ble") {
    return ["mode:ble", "transport:ble", "ble"];
  }
  return ["mode:auto", "transport:auto", "auto"];
}

function modeEvidence(mode, diagnostics) {
  const text = JSON.stringify(diagnostics || {}).toLowerCase();
  const needles =
    mode === "cancel"
      ? ["cancel", "owner released", "play done"]
      : mode === "ble"
        ? ["ble connected", "ble advertising", "source=ble", "audio stream start source=ble"]
        : mode === "auto"
          ? ["wifi connected", "ble advertising", "mqtt connected"]
          : ["wifi connected", "mqtt connected", "source=mqtt", "audio stream start source=mqtt"];
  const matchedNeedle = needles.find((needle) => text.includes(needle));
  return {
    matched: Boolean(matchedNeedle),
    matchedNeedle: matchedNeedle || null,
    expectedSignals: needles,
  };
}

async function resolveAudioSelection({ audio, roots, recursive }) {
  const direct = resolvePath(audio);
  if (direct && existsSync(direct) && statSync(direct).isFile()) {
    return { ...fileInfo(requireAudioPath(direct)), selection: audio, match: "path" };
  }
  const listed = await listAudioFiles({
    roots: arrayOrDefault(roots, DEFAULT_AUDIO_ROOTS),
    recursive: Boolean(recursive),
    limit: 500,
  });
  const needle = audio.toLowerCase();
  const exact = listed.files.filter((file) => file.name.toLowerCase() === needle);
  const basename = listed.files.filter((file) => path.basename(file.name, path.extname(file.name)).toLowerCase() === needle);
  const contains = listed.files.filter((file) => file.name.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle));
  const matches = exact.length > 0 ? exact : basename.length > 0 ? basename : contains;
  if (matches.length === 0) {
    throw new Error(`audio selection did not match any supported file: ${audio}`);
  }
  if (matches.length > 1) {
    return {
      ...matches[0],
      selection: audio,
      match: "ambiguous_first",
      alternatives: matches.slice(0, 20),
      warning: `audio selection matched ${matches.length} files; using the first sorted match`,
    };
  }
  return { ...matches[0], selection: audio, match: exact.length ? "exact_name" : basename.length ? "basename" : "substring" };
}

async function loadDeviceProfiles() {
  try {
    const parsed = JSON.parse(await readFile(PROFILES_PATH, "utf8"));
    const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    return {
      defaultProfile: typeof parsed.defaultProfile === "string" ? parsed.defaultProfile : profiles[0]?.name || null,
      profiles: profiles.map(normalizeDeviceProfile),
    };
  } catch {
    const fallback = normalizeDeviceProfile({
      name: DEFAULT_DEVICE_ID,
      description: "Built-in fallback target.",
      deviceId: DEFAULT_DEVICE_ID,
      mqttBroker: DEFAULT_MQTT_BROKER,
      bleDeviceName: DEFAULT_BLE_DEVICE_NAME,
      adapter: "hci0",
      serialPort: "/dev/ttyACM0",
      audioRoots: DEFAULT_AUDIO_ROOTS,
    });
    return { defaultProfile: fallback.name, profiles: [fallback] };
  }
}

function normalizeDeviceProfile(profile) {
  return {
    name: stringOrDefault(profile.name, profile.deviceId || DEFAULT_DEVICE_ID),
    description: stringOrDefault(profile.description, ""),
    deviceId: stringOrDefault(profile.deviceId, DEFAULT_DEVICE_ID),
    mqttBroker: stringOrDefault(profile.mqttBroker, DEFAULT_MQTT_BROKER),
    suggestedLanBroker: stringOrDefault(profile.suggestedLanBroker, ""),
    bleDeviceName: stringOrDefault(profile.bleDeviceName, DEFAULT_BLE_DEVICE_NAME),
    bleDevice: stringOrDefault(profile.bleDevice, ""),
    adapter: stringOrDefault(profile.adapter, "hci0"),
    serialPort: stringOrDefault(profile.serialPort, "/dev/ttyACM0"),
    audioRoots: arrayOrDefault(profile.audioRoots, DEFAULT_AUDIO_ROOTS),
  };
}

async function resolveDeviceProfile(name) {
  const registry = await loadDeviceProfiles();
  const targetName = stringOrDefault(name, registry.defaultProfile || "");
  return registry.profiles.find((profile) => profile.name === targetName || profile.deviceId === targetName) || null;
}

function chooseReadyTransport(transports, readiness) {
  return transports.find((transport) => readiness[transport]?.ready) || null;
}

function flattenNextSteps(transports, readiness) {
  const steps = [];
  for (const transport of transports) {
    for (const step of readiness[transport]?.nextSteps || []) {
      steps.push(`${transport}: ${step}`);
    }
  }
  return steps;
}

function smokeCheck(name, status, message, details = null) {
  return { name, status, message, details };
}

function suggestLanBroker(localAddresses, broker) {
  let port = 1883;
  try {
    port = Number(new URL(broker).port || 1883);
  } catch {
    port = 1883;
  }
  const matches = String(localAddresses || "").match(/\b(?:192\.168|10\.|172\.(?:1[6-9]|2\d|3[0-1]))\.\d+\.\d+\b/g);
  const ip = matches?.find((candidate) => !candidate.startsWith("127."));
  return ip ? `mqtt://${ip}:${port}` : null;
}

function buildMqttConnectPacket(clientId) {
  const body = Buffer.concat([
    mqttString("MQTT"),
    Buffer.from([0x04, 0x02, 0x00, 0x0a]),
    mqttString(clientId),
  ]);
  return Buffer.concat([Buffer.from([0x10]), mqttRemainingLength(body.length), body]);
}

function buildMqttPublishPacket(topic, payload) {
  const body = Buffer.concat([mqttString(topic), payload]);
  return Buffer.concat([Buffer.from([0x30]), mqttRemainingLength(body.length), body]);
}

function buildMqttSubscribePacket(packetId, topics) {
  const variableHeader = Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]);
  const payload = Buffer.concat(topics.map((topic) => Buffer.concat([mqttString(topic), Buffer.from([0x00])])));
  const body = Buffer.concat([variableHeader, payload]);
  return Buffer.concat([Buffer.from([0x82]), mqttRemainingLength(body.length), body]);
}

function buildMqttDisconnectPacket() {
  return Buffer.from([0xe0, 0x00]);
}

function mqttString(value) {
  const encoded = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([(encoded.length >> 8) & 0xff, encoded.length & 0xff]), encoded]);
}

function mqttRemainingLength(value) {
  const out = [];
  let remaining = value;
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      digit |= 128;
    }
    out.push(digit);
  } while (remaining > 0);
  return Buffer.from(out);
}

function readMqttPacket(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  let multiplier = 1;
  let value = 0;
  let offset = 1;
  let encodedByte = 0;
  do {
    if (offset >= buffer.length) {
      return null;
    }
    encodedByte = buffer[offset++];
    value += (encodedByte & 127) * multiplier;
    multiplier *= 128;
    if (multiplier > 128 * 128 * 128 * 128) {
      throw new Error("malformed MQTT remaining length");
    }
  } while ((encodedByte & 128) !== 0);
  const end = offset + value;
  if (buffer.length < end) {
    return null;
  }
  return {
    header: buffer[0],
    body: buffer.subarray(offset, end),
    bytes: end,
  };
}

function parseMqttPublish(body) {
  if (body.length < 2) {
    return { topic: "", bytes: 0, payloadHex: "", payloadText: "", parsed: null };
  }
  const topicLength = body.readUInt16BE(0);
  const topicStart = 2;
  const topicEnd = topicStart + topicLength;
  const topic = body.subarray(topicStart, topicEnd).toString("utf8");
  const payload = body.subarray(topicEnd);
  const text = payload.toString("utf8");
  return {
    topic,
    bytes: payload.length,
    payloadHex: payload.toString("hex"),
    payloadText: isMostlyText(payload) ? text : null,
    parsed: parseKnownMqttPayload(topic, payload),
    receivedAt: new Date().toISOString(),
  };
}

function parseKnownMqttPayload(topic, payload) {
  if (topic.endsWith("/audio/status") && payload.length >= 23 && payload[0] === 0x10) {
    return {
      type: "audio_status",
      free: payload.readUInt32LE(1),
      fill: payload.readUInt32LE(5),
      received: payload.readUInt32LE(9),
      read: payload.readUInt32LE(13),
      highWater: payload.readUInt32LE(17),
      active: payload[21],
      finished: payload[22],
    };
  }
  if (topic.endsWith("/state") || topic.endsWith("/cmd")) {
    return parseMaybeJson(payload.toString("utf8"));
  }
  return null;
}

function isMostlyText(buffer) {
  if (buffer.length === 0) {
    return true;
  }
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f) || byte >= 0x80) {
      printable += 1;
    }
  }
  return printable / buffer.length > 0.85;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pythonCommand() {
  return process.env.PYTHON || "python3";
}

async function readProcCmdline(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    return raw.toString("utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

async function runCommand(command, args, options = {}) {
  const timeoutSeconds = clampNumber(options.timeoutSeconds, 1, 7200, 60);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, timeoutSeconds * 1000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = { code: code ?? 128, signal, stdout, stderr };
      if (!options.allowFailure && result.code !== 0) {
        reject(new Error(`${command} exited with code ${result.code}: ${stderr || stdout}`.trim()));
        return;
      }
      resolve(result);
    });
  });
}

await mkdir(path.join(REPO_ROOT, "MCP"), { recursive: true });
await writeFile(path.join(REPO_ROOT, "MCP", ".server-ready"), new Date().toISOString(), "utf8").catch(() => {});
