#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const profile = process.env.MCP_SMOKE_PROFILE || "live2d-atri";
const audio = process.env.MCP_SMOKE_AUDIO || "ATR_b102_015";
const realSend = process.env.MCP_SMOKE_REAL_SEND === "1";
const includeLocalBroker = process.env.MCP_SMOKE_LOCAL_BROKER !== "0";
const includeMqttListen = process.env.MCP_SMOKE_MQTT_LISTEN !== "0";
const realTransport = process.env.MCP_SMOKE_REAL_TRANSPORT || "auto";

const optional = [];
for (const [envName, label] of [
  ["MCP_SMOKE_BROKER", "broker"],
  ["MCP_SMOKE_DEVICE_ID", "deviceId"],
  ["MCP_SMOKE_BLE_DEVICE", "bleDevice"],
  ["MCP_SMOKE_SERIAL_PORT", "serialPort"],
  ["MCP_SMOKE_SERIAL_SECONDS", "serialSeconds"],
]) {
  if (process.env[envName]) {
    optional.push(`${label} ${process.env[envName]}`);
  }
}

const prompt = [
  "Use live2dagenttools MCP only.",
  "Call smoke_test_transports with:",
  `profile ${profile}`,
  `audio ${audio}`,
  `includeLocalBroker ${includeLocalBroker}`,
  `includeMqttListen ${includeMqttListen}`,
  `realSend ${realSend}`,
  `realTransport ${realTransport}`,
  ...optional,
  "Summarize ok, readyForRealAudio, failed check names, and next steps.",
].join(" ");

const child = spawn(
  "claude",
  [
    "--mcp-config",
    ".mcp.json",
    "--allowedTools",
    "mcp__live2dagenttools__smoke_test_transports",
    "-p",
    prompt,
  ],
  {
    cwd: process.cwd(),
    stdio: "inherit",
  },
);

child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
