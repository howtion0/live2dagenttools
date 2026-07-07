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

await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "live2d-mcp-profile-client", version: "0.1.0" },
});
notify("notifications/initialized");

try {
  const response = await request("tools/call", {
    name: "validate_device_profiles",
    arguments: { includeReadiness: process.env.MCP_PROFILE_READINESS === "1" },
  });
  const result = parseToolText(response);
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        profilePath: result.profilePath,
        defaultProfile: result.defaultProfile,
        profileCount: result.profileCount,
        errors: result.errors,
        warnings: result.warnings,
        profiles: (result.profiles || []).map((profile) => ({
          name: profile.name,
          deviceId: profile.deviceId,
          errors: profile.errors,
          warnings: profile.warnings,
        })),
      },
      null,
      2,
    ),
  );
  process.exitCode = result.ok ? 0 : 1;
} finally {
  server.kill("SIGTERM");
}
