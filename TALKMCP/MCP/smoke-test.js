#!/usr/bin/env node
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "server.js");

const child = spawn("node", [serverPath], {
  cwd: path.resolve(__dirname, ".."),
  stdio: ["pipe", "pipe", "inherit"]
});

let nextId = 1;
let buffer = "";
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function textPayload(response) {
  return JSON.parse(response.result.content[0].text);
}

try {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "talkmcp-smoke", version: "0" }
  });

  const listed = await request("tools/list");
  const names = listed.result.tools.map((tool) => tool.name);
  assert(names.includes("speak_stream_intent"));
  assert(names.includes("check_runtime_connections"));
  assert(names.includes("connection_mode_help"));

  const dryRun = await request("tools/call", {
    name: "speak_stream_intent",
    arguments: {
      text: "这是 smoke test 的字面语音文本。",
      transport: "auto",
      dryRun: true
    }
  });
  const dry = textPayload(dryRun);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.textChars, "这是 smoke test 的字面语音文本。".length);
  assert.equal(dry.tts.provider, "volcengine");

  const noTransport = await request("tools/call", {
    name: "speak_stream_intent",
    arguments: {
      text: "这里应该返回连接模式提示。",
      transport: "mqtt",
      broker: "mqtt://127.0.0.1:9",
      dryRun: true
    }
  });
  const blocked = textPayload(noTransport);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "no ready transport");
  assert(Array.isArray(blocked.nextSteps));

  const invalid = await request("tools/call", {
    name: "speak_stream_intent",
    arguments: {
      text: "这句话合法，但 extra 字段必须被拒绝。",
      dryRun: true,
      command: "reset"
    }
  });
  assert(invalid.error);
  assert(String(invalid.error.message).includes("unknown field command"));

  console.log(JSON.stringify({ ok: true, tests: 4 }, null, 2));
} finally {
  child.stdin.end();
  child.kill();
}
