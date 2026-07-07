#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [toolName, jsonArgs = "{}"] = process.argv.slice(2);
if (!toolName) {
  console.error("usage: node MCP/call-tool.js <tool-name> [json-args]");
  process.exit(64);
}

let args;
try {
  args = JSON.parse(jsonArgs);
} catch (error) {
  console.error(`invalid json args: ${error.message}`);
  process.exit(64);
}

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

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "live2d-mcp-call-tool", version: "0.1.0" },
});
if (init.error) {
  console.error(JSON.stringify(init.error, null, 2));
  server.kill("SIGTERM");
  process.exit(1);
}

notify("notifications/initialized");
const response = await request("tools/call", { name: toolName, arguments: args });
server.kill("SIGTERM");

if (response.error) {
  console.error(JSON.stringify(response.error, null, 2));
  process.exit(1);
}

const text = response.result?.content?.find((item) => item.type === "text")?.text;
if (text) {
  console.log(text);
} else {
  console.log(JSON.stringify(response.result, null, 2));
}

if (response.result?.isError) {
  process.exit(1);
}
