#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let buffer = Buffer.alloc(0);
const pending = new Map();

server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const message = readMessage();
    if (!message) {
      return;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

server.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

function readMessage() {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return null;
  }
  const header = buffer.subarray(0, headerEnd).toString("utf8");
  const match = /^Content-Length:\s*(\d+)/im.exec(header);
  if (!match) {
    throw new Error("missing Content-Length");
  }
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) {
    return null;
  }
  const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
  buffer = buffer.subarray(bodyEnd);
  return JSON.parse(body);
}

function request(method, params = {}) {
  const id = nextId++;
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
  server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  server.stdin.write(body);
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(method, params = {}) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }), "utf8");
  server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  server.stdin.write(body);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "live2d-mcp-test-client", version: "0.1.0" },
});
notify("notifications/initialized");
const listed = await request("tools/list");
const toolNames = new Set(listed.result.tools.map((tool) => tool.name));
for (const name of [
  "list_audio_files",
  "probe_audio",
  "scan_ble_devices",
  "check_mqtt_broker",
  "listen_mqtt_topics",
  "diagnose_runtime",
  "diagnose_wifi_mqtt",
  "list_runtime_targets",
  "list_device_profiles",
  "validate_device_profiles",
  "start_local_mqtt_broker",
  "stop_local_mqtt_broker",
  "prepare_transport",
  "play_audio_intent",
  "smoke_test_transports",
  "integration_status",
  "send_audio",
  "batch_send_audio",
  "read_esp32_serial",
  "send_control_command",
  "switch_transport_mode",
]) {
  if (!toolNames.has(name)) {
    throw new Error(`missing MCP tool: ${name}`);
  }
}
const files = await request("tools/call", { name: "list_audio_files", arguments: { limit: 4 } });
const targets = await request("tools/call", {
  name: "list_runtime_targets",
  arguments: { broker: "mqtt://192.168.11.73:1883", deviceId: "live2d-atri", audioLimit: 3 },
});
const wifiDiag = await request("tools/call", {
  name: "diagnose_wifi_mqtt",
  arguments: {
    profile: "live2d-atri",
    broker: "mqtt://127.0.0.1:1883",
    deviceId: "live2d-atri",
    serialSeconds: 1,
    listenSeconds: 1,
  },
});
const profiles = await request("tools/call", {
  name: "list_device_profiles",
  arguments: { includeReadiness: false },
});
const validatedProfiles = await request("tools/call", {
  name: "validate_device_profiles",
  arguments: { includeReadiness: false },
});
const localBroker = await request("tools/call", {
  name: "start_local_mqtt_broker",
  arguments: { port: 1883 },
});
const brokerCheck = await request("tools/call", {
  name: "check_mqtt_broker",
  arguments: { broker: "mqtt://127.0.0.1:1883", timeoutSeconds: 2 },
});
const listenLocal = await request("tools/call", {
  name: "listen_mqtt_topics",
  arguments: {
    broker: "mqtt://127.0.0.1:1883",
    topics: ["live2d/live2d-atri/state", "live2d/live2d-atri/audio/status"],
    durationSeconds: 1,
    maxMessages: 2,
  },
});
const controlDryRun = await request("tools/call", {
  name: "send_control_command",
  arguments: {
    transport: "mqtt",
    broker: "mqtt://127.0.0.1:1883",
    command: "ping",
    dryRun: true,
  },
});
const listenCommandPromise = request("tools/call", {
  name: "listen_mqtt_topics",
  arguments: {
    broker: "mqtt://127.0.0.1:1883",
    topics: ["live2d/live2d-atri/cmd"],
    durationSeconds: 2,
    maxMessages: 1,
  },
});
await sleep(300);
const controlPublish = await request("tools/call", {
  name: "send_control_command",
  arguments: {
    transport: "mqtt",
    broker: "mqtt://127.0.0.1:1883",
    command: "ping",
  },
});
const listenCommand = await listenCommandPromise;
const switchDryRun = await request("tools/call", {
  name: "switch_transport_mode",
  arguments: {
    mode: "mqtt",
    method: "serial",
    command: "mode:mqtt",
    dryRun: true,
    verify: false,
  },
});
const intentDryRun = await request("tools/call", {
  name: "play_audio_intent",
  arguments: {
    audio: "ATR_b102_015",
    profile: "live2d-atri",
    transport: "auto",
    dryRun: true,
    allowFallback: true,
    broker: "mqtt://192.168.11.73:1883",
    deviceId: "live2d-atri",
    bleDevice: "28:84:85:90:B2:2E",
    serialSeconds: 1,
  },
});
const smoke = await request("tools/call", {
  name: "smoke_test_transports",
  arguments: {
    audio: "ATR_b102_015",
    profile: "live2d-atri",
    broker: "mqtt://192.168.11.73:1883",
    deviceId: "live2d-atri",
    bleDevice: "28:84:85:90:B2:2E",
    serialSeconds: 1,
    includeLocalBroker: true,
    includeMqttListen: true,
    realSend: false,
  },
});
const integration = await request("tools/call", {
  name: "integration_status",
  arguments: {
    profile: "live2d-atri",
    audio: "ATR_b102_015",
    includeReadiness: false,
  },
});
const dryRun = await request("tools/call", {
  name: "send_audio",
  arguments: {
    transport: "mqtt",
    input: "/run/media/howtion/thinkplus/1.8/测试音频/ATR_b102_015.wav",
    dryRun: true,
    broker: "mqtt://192.168.11.73:1883",
  },
});
const prepared = await request("tools/call", {
  name: "prepare_transport",
  arguments: {
    transport: "mqtt",
    input: "/run/media/howtion/thinkplus/1.8/测试音频/ATR_b102_015.wav",
    broker: "mqtt://192.168.11.73:1883",
    serialSeconds: 1,
  },
});

console.log(JSON.stringify({ init, listed, files, targets, wifiDiag, profiles, validatedProfiles, localBroker, brokerCheck, listenLocal, controlDryRun, controlPublish, listenCommand, switchDryRun, intentDryRun, smoke, integration, dryRun, prepared }, null, 2));
server.kill("SIGTERM");
