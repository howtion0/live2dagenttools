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

server.stderr.on("data", (chunk) => process.stderr.write(chunk));

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

function parseToolText(response) {
  const text = response.result?.content?.[0]?.text;
  if (!text) {
    throw new Error(`missing tool text: ${JSON.stringify(response)}`);
  }
  return JSON.parse(text);
}

const args = {
  audio: process.env.MCP_SMOKE_AUDIO || "ATR_b102_015",
  profile: process.env.MCP_SMOKE_PROFILE || "live2d-atri",
  includeLocalBroker: process.env.MCP_SMOKE_LOCAL_BROKER !== "0",
  includeMqttListen: process.env.MCP_SMOKE_MQTT_LISTEN !== "0",
  realSend: process.env.MCP_SMOKE_REAL_SEND === "1",
  realTransport: process.env.MCP_SMOKE_REAL_TRANSPORT || "auto",
};

for (const [envName, argName] of [
  ["MCP_SMOKE_BROKER", "broker"],
  ["MCP_SMOKE_DEVICE_ID", "deviceId"],
  ["MCP_SMOKE_BLE_DEVICE", "bleDevice"],
  ["MCP_SMOKE_SERIAL_PORT", "serialPort"],
]) {
  if (process.env[envName]) {
    args[argName] = process.env[envName];
  }
}

if (process.env.MCP_SMOKE_SERIAL_SECONDS) {
  args.serialSeconds = Number(process.env.MCP_SMOKE_SERIAL_SECONDS);
}

await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "live2d-mcp-smoke-client", version: "0.1.0" },
});
notify("notifications/initialized");

try {
  const response = await request("tools/call", { name: "smoke_test_transports", arguments: args });
  const smoke = parseToolText(response);
  const summary = {
    ok: smoke.ok,
    readyForRealAudio: smoke.readyForRealAudio,
    realSendAttempted: smoke.realSendAttempted,
    audio: smoke.audio?.path,
    broker: smoke.broker,
    deviceId: smoke.deviceId,
    checks: (smoke.checks || []).map((check) => ({
      name: check.name,
      status: check.status,
      message: check.message,
    })),
    nextSteps: smoke.nextSteps || [],
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = smoke.readyForRealAudio ? 0 : 2;
} finally {
  server.kill("SIGTERM");
}
