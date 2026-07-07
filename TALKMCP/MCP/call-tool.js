#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "server.js");
const toolName = process.argv[2] || "tools/list";
const rawArgs = process.argv[3] || "{}";

const child = spawn("node", [serverPath], {
  cwd: path.resolve(__dirname, ".."),
  stdio: ["pipe", "pipe", "inherit"]
});

let nextId = 1;
let buffer = "";

function send(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })}\n`);
}

function waitForResponse() {
  return new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        resolve(JSON.parse(line));
      }
    });
  });
}

send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "talkmcp-call", version: "0" } });
await waitForResponse();

if (toolName === "tools/list") {
  send("tools/list");
} else {
  send("tools/call", { name: toolName, arguments: JSON.parse(rawArgs) });
}

const response = await waitForResponse();
console.log(JSON.stringify(response, null, 2));
child.stdin.end();
child.kill();
