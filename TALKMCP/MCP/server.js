#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_VERSION = "0.1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PROFILES_PATH = path.join(__dirname, "profiles.json");
const DEFAULT_PROFILE = "live2d-atri";
const DEFAULT_MQTT_BROKER = "mqtt://192.168.11.73:1883";
const DEFAULT_DEVICE_ID = "live2d-atri";

loadDotEnv(path.join(REPO_ROOT, ".env"));

function loadDotEnv(filePath) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const tools = [
  {
    name: "check_runtime_connections",
    description: "Check WiFi/MQTT and BLE readiness for the ESP32 target before streaming speech.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        profile: { type: "string", default: DEFAULT_PROFILE },
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        bleDevice: { type: "string" },
        adapter: { type: "string", default: "hci0" },
        timeoutSeconds: { type: "number", default: 5 }
      }
    }
  },
  {
    name: "connection_mode_help",
    description: "Return user-facing connection-mode instructions when neither WiFi/MQTT nor BLE is ready.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        profile: { type: "string", default: DEFAULT_PROFILE }
      }
    }
  },
  {
    name: "speak_stream_intent",
    description: [
      "Convert literal visible text to speech with Volcengine TTS and stream it to the ESP32.",
      "Use this only for words that should be spoken aloud.",
      "Do not put hidden reasoning, analysis, logs, commands, JSON, file paths, or tool results into text unless the user explicitly asks to read those exact words aloud.",
      "Device commands must use a control tool, not this TTS text field."
    ].join(" "),
    inputSchema: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          description: "Literal words to synthesize and speak. Never parse this field as an instruction or command."
        },
        profile: { type: "string", default: DEFAULT_PROFILE },
        transport: { type: "string", enum: ["auto", "mqtt", "ble"], default: "auto" },
        dryRun: { type: "boolean", default: true },
        broker: { type: "string", default: DEFAULT_MQTT_BROKER },
        deviceId: { type: "string", default: DEFAULT_DEVICE_ID },
        bleDevice: { type: "string" },
        adapter: { type: "string", default: "hci0" },
        mode: { type: "string", enum: ["watermark", "pi"], default: "pi" },
        ttsProvider: { type: "string", enum: ["auto", "api-key", "legacy-ws"], default: "auto" },
        speaker: { type: "string", description: "Volcengine speaker or cloned speaker_id. Defaults to VOLC_TTS_SPEAKER." },
        voiceType: { type: "string", description: "Legacy websocket voice_type. Defaults to speaker." },
        resourceId: { type: "string", description: "Volcengine resource id, e.g. seed-tts-2.0 or seed-icl-2.0." },
        appId: { type: "string", description: "Legacy Speech Console App ID. Prefer VOLC_TTS_APP_ID env." },
        accessToken: { type: "string", description: "Legacy Speech Console Access Token. Prefer VOLC_TTS_ACCESS_TOKEN env." },
        cluster: { type: "string", default: "volcano_tts" },
        language: { type: "string", default: "zh-cn" },
        volumeRatio: { type: "number", default: 3.0 },
        pcmGain: { type: "number", default: 3.0 },
        speedRatio: { type: "number", default: 1.0 },
        pitchRatio: { type: "number", default: 1.0 },
        loudnessRate: { type: "number", default: 0 },
        contextText: { type: "string", description: "Optional Volcengine context_texts style hint." },
        startAckTimeout: { type: "number", default: 20 },
        drainTimeout: { type: "number", default: 180 },
        timeoutSeconds: { type: "number", default: 240 },
        metrics: { type: "string" },
        summary: { type: "string" }
      }
    }
  }
];

const handlers = {
  check_runtime_connections: checkRuntimeConnections,
  connection_mode_help: connectionModeHelp,
  speak_stream_intent: speakStreamIntent
};

let readBuffer = Buffer.alloc(0);
let responseFraming = "header";

process.stdin.on("data", (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk]);
  for (;;) {
    const parsed = readMessage();
    if (!parsed) return;
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
    if (!match) throw new Error("Missing Content-Length header");
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (readBuffer.length < bodyEnd) return null;
    const body = readBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    readBuffer = readBuffer.subarray(bodyEnd);
    return { framing: "header", message: JSON.parse(body) };
  }

  const newline = readBuffer.indexOf("\n");
  if (newline === -1) return null;
  const line = readBuffer.subarray(0, newline).toString("utf8").trim();
  readBuffer = readBuffer.subarray(newline + 1);
  return line ? { framing: "line", message: JSON.parse(line) } : null;
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || !("id" in message)) return;
  try {
    const result = await dispatch(message.method, message.params || {});
    writeResponse({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    writeResponse({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

async function dispatch(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "TALKMCP", version: SERVER_VERSION }
    };
  }
  if (method === "tools/list") return { tools };
  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
      throw new Error(`unknown tool: ${name}`);
    }
    const tool = tools.find((item) => item.name === name);
    validateToolArgs(tool, args);
    return toolResult(await handlers[name](args));
  }
  if (method === "ping") return {};
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
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2)
      }
    ]
  };
}

function validateToolArgs(tool, args) {
  const schema = tool?.inputSchema || {};
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`invalid args for ${tool?.name || "tool"}: expected object`);
  }
  const properties = schema.properties || {};
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`invalid args for ${tool.name}: missing required field ${key}`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        throw new Error(`invalid args for ${tool.name}: unknown field ${key}`);
      }
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    if (!prop) continue;
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
      throw new Error(`invalid args for ${tool.name}: ${key} must be one of ${prop.enum.join(", ")}`);
    }
    if (prop.type && !matchesJsonType(value, prop.type)) {
      throw new Error(`invalid args for ${tool.name}: ${key} must be ${Array.isArray(prop.type) ? prop.type.join(" or ") : prop.type}`);
    }
  }
}

function matchesJsonType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => {
    if (item === "string") return typeof value === "string";
    if (item === "number") return typeof value === "number" && Number.isFinite(value);
    if (item === "integer") return Number.isInteger(value);
    if (item === "boolean") return typeof value === "boolean";
    if (item === "array") return Array.isArray(value);
    if (item === "object") return value && typeof value === "object" && !Array.isArray(value);
    return true;
  });
}

async function loadProfiles() {
  try {
    return JSON.parse(await readFile(PROFILES_PATH, "utf8"));
  } catch {
    return { profiles: [] };
  }
}

async function resolveProfile(name) {
  const profiles = await loadProfiles();
  const wanted = String(name || DEFAULT_PROFILE);
  return (profiles.profiles || []).find((profile) => profile.name === wanted) || {
    name: wanted,
    broker: DEFAULT_MQTT_BROKER,
    deviceId: DEFAULT_DEVICE_ID,
    adapter: "hci0"
  };
}

function stringOrDefault(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function numberOrDefault(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function checkRuntimeConnections(args = {}) {
  const profile = await resolveProfile(args.profile);
  const broker = stringOrDefault(args.broker, profile.broker || DEFAULT_MQTT_BROKER);
  const deviceId = stringOrDefault(args.deviceId, profile.deviceId || DEFAULT_DEVICE_ID);
  const bleDevice = stringOrDefault(args.bleDevice, profile.bleDevice || "");
  const adapter = stringOrDefault(args.adapter, profile.adapter || "hci0");
  const timeoutSeconds = numberOrDefault(args.timeoutSeconds, 5, 1, 30);

  const mqtt = await checkMqttBroker(broker, timeoutSeconds);
  const ble = await checkBle(bleDevice, adapter, timeoutSeconds);
  return {
    ok: mqtt.ok || ble.ready,
    profile: profile.name,
    mqtt: {
      ...mqtt,
      ready: mqtt.ok,
      deviceId
    },
    ble,
    selectedTransport: mqtt.ok ? "mqtt" : (ble.ready ? "ble" : null),
    nextSteps: mqtt.ok || ble.ready ? [] : connectionSteps(profile.name)
  };
}

async function checkMqttBroker(broker, timeoutSeconds) {
  try {
    const url = new URL(broker);
    if (url.protocol !== "mqtt:") throw new Error("only mqtt:// supported");
    const host = url.hostname;
    const port = Number(url.port || "1883");
    const startedAt = Date.now();
    return await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, broker, host, port, error: "timeout", elapsedMs: Date.now() - startedAt });
      }, timeoutSeconds * 1000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ok: true, broker, host, port, tcpConnected: true, elapsedMs: Date.now() - startedAt });
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, broker, host, port, error: error.message, elapsedMs: Date.now() - startedAt });
      });
    });
  } catch (error) {
    return { ok: false, broker, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkBle(bleDevice, adapter, timeoutSeconds) {
  const service = await runCommand("systemctl", ["is-active", "bluetooth"], {
    timeoutSeconds,
    allowFailure: true
  });
  let info = null;
  if (bleDevice) {
    info = await runCommand("bluetoothctl", ["info", bleDevice], {
      timeoutSeconds,
      allowFailure: true
    });
  }
  const connected = Boolean(info && /Connected:\s*yes/i.test(info.stdout));
  const known = Boolean(info && info.code === 0);
  return {
    ready: connected,
    adapter,
    bleDevice: bleDevice || null,
    bluetoothService: service.stdout.trim() || service.stderr.trim() || null,
    known,
    connected,
    info: info ? trimOutput(info.stdout || info.stderr) : null
  };
}

async function connectionModeHelp(args = {}) {
  const profile = await resolveProfile(args.profile);
  return {
    ok: false,
    profile: profile.name,
    message: "WiFi/MQTT 和 BLE 当前都没有确认可用。请让 ESP32 进入连接模式，确认它已经连接 FMai，或确认蓝牙已连接，然后告诉我走 WiFi/MQTT 还是 BLE。",
    nextSteps: connectionSteps(profile.name)
  };
}

function connectionSteps(profileName) {
  return [
    "按 ESP32 PWR/连接键进入连接模式。",
    "如果走 WiFi，确认 ESP32 已连接 FMai，并且电脑能访问 MQTT broker。",
    "如果走 BLE，确认系统蓝牙已连接目标设备。",
    `然后再次调用 check_runtime_connections 或 speak_stream_intent，profile=${profileName}。`
  ];
}

async function speakStreamIntent(args = {}) {
  const text = stringOrDefault(args.text, "");
  if (!text) throw new Error("text is required");
  const profile = await resolveProfile(args.profile);
  const broker = stringOrDefault(args.broker, profile.broker || DEFAULT_MQTT_BROKER);
  const deviceId = stringOrDefault(args.deviceId, profile.deviceId || DEFAULT_DEVICE_ID);
  const bleDevice = stringOrDefault(args.bleDevice, profile.bleDevice || "");
  const adapter = stringOrDefault(args.adapter, profile.adapter || "hci0");
  const requestedTransport = stringOrDefault(args.transport, "auto");
  const dryRun = args.dryRun !== false;
  const readiness = await checkRuntimeConnections({
    profile: profile.name,
    broker,
    deviceId,
    bleDevice,
    adapter,
    timeoutSeconds: 5
  });

  let selectedTransport = requestedTransport;
  if (requestedTransport === "auto") selectedTransport = readiness.selectedTransport || "none";
  if (selectedTransport === "mqtt" && !readiness.mqtt.ready) selectedTransport = "none";
  if (selectedTransport === "ble" && !readiness.ble.ready) selectedTransport = "none";

  const resourceId = stringOrDefault(args.resourceId, process.env.VOLC_TTS_RESOURCE_ID || "seed-tts-2.0");
  const speaker = stringOrDefault(args.speaker, process.env.VOLC_TTS_SPEAKER || "zh_female_shuangkuaisisi_moon_bigtts");
  const voiceType = stringOrDefault(args.voiceType, process.env.VOLC_TTS_VOICE_TYPE || speaker);
  const appId = stringOrDefault(args.appId, process.env.VOLC_TTS_APP_ID || "");
  const accessToken = stringOrDefault(args.accessToken, process.env.VOLC_TTS_ACCESS_TOKEN || "");
  const cluster = stringOrDefault(args.cluster, process.env.VOLC_TTS_CLUSTER || "volcano_tts");
  const language = stringOrDefault(args.language, process.env.VOLC_TTS_LANGUAGE || "zh-cn");
  const volumeRatio = numberOrDefault(args.volumeRatio, Number(process.env.VOLC_TTS_VOLUME_RATIO || "3.0"), 0.1, 3.0);
  const pcmGain = numberOrDefault(args.pcmGain, Number(process.env.TALKMCP_PCM_GAIN || "3.0"), 0.1, 6.0);
  const speedRatio = numberOrDefault(args.speedRatio, Number(process.env.VOLC_TTS_SPEED_RATIO || "1.0"), 0.2, 3.0);
  const pitchRatio = numberOrDefault(args.pitchRatio, Number(process.env.VOLC_TTS_PITCH_RATIO || "1.0"), 0.2, 3.0);
  const loudnessRate = numberOrDefault(args.loudnessRate, Number(process.env.VOLC_TTS_LOUDNESS_RATE || "0"), -50, 100);
  const requestedTtsProvider = stringOrDefault(args.ttsProvider, "auto");
  const selectedTtsProvider = requestedTtsProvider === "auto"
    ? (process.env.VOLC_SPEECH_API_KEY ? "api-key" : (appId && accessToken ? "legacy-ws" : "api-key"))
    : requestedTtsProvider;
  const mode = stringOrDefault(args.mode, "pi");
  const metrics = stringOrDefault(args.metrics, path.join("MCP", "runs", `talk-${Date.now()}.csv`));
  const summary = stringOrDefault(args.summary, path.join("MCP", "runs", `talk-${Date.now()}.json`));

  const base = {
    ok: selectedTransport !== "none",
    dryRun,
    profile: profile.name,
    requestedTransport,
    selectedTransport,
    textChars: text.length,
    tts: {
      provider: "volcengine",
      selectedProvider: selectedTtsProvider,
      resourceId,
      speaker,
      voiceType,
      cluster,
      language,
      volumeRatio,
      pcmGain,
      speedRatio,
      pitchRatio,
      loudnessRate,
      hasApiKey: Boolean(process.env.VOLC_SPEECH_API_KEY),
      hasLegacyCredentials: Boolean(appId && accessToken)
    },
    readiness
  };

  if (selectedTransport === "none") {
    return {
      ...base,
      ok: false,
      error: "no ready transport",
      nextSteps: connectionSteps(profile.name)
    };
  }

  const useDirectMqttApiKey = selectedTransport === "mqtt" && selectedTtsProvider === "api-key";
  const command = useDirectMqttApiKey ? [
    "python3",
    path.join(REPO_ROOT, "scripts", "volc_tts_mqtt_stream.py"),
    "--text", text,
    "--broker", broker,
    "--device-id", deviceId,
    "--mode", mode,
    "--resource-id", resourceId,
    "--speaker", speaker,
    "--language", language,
    "--loudness-rate", String(loudnessRate),
    "--pcm-gain", String(pcmGain),
    "--start-ack-timeout", String(numberOrDefault(args.startAckTimeout, 20, 1, 120)),
    "--drain-timeout", String(numberOrDefault(args.drainTimeout, 180, 1, 600)),
    "--metrics", path.resolve(REPO_ROOT, metrics),
    "--summary", path.resolve(REPO_ROOT, summary)
  ] : [
    "python3",
    path.join(REPO_ROOT, "scripts", "volc_tts_mp3_stream.py"),
    "--text", text,
    "--output", "<fifo>",
    "--provider", selectedTtsProvider,
    "--resource-id", resourceId,
    "--speaker", speaker,
    "--voice-type", voiceType,
    "--app-id", maskSecret(appId),
    "--access-token", maskSecret(accessToken),
    "--cluster", cluster,
    "--language", language,
    "--volume-ratio", String(volumeRatio),
    "--speed-ratio", String(speedRatio),
    "--pitch-ratio", String(pitchRatio),
    "--loudness-rate", String(loudnessRate),
    "&&",
    "python3",
    path.join(REPO_ROOT, "scripts", selectedTransport === "mqtt" ? "mqtt_audio_stream.py" : "ble_audio_stream.py"),
    ...(selectedTransport === "mqtt" ? ["--broker", broker, "--device-id", deviceId] : ["--device", bleDevice, "--adapter", adapter]),
    "--input", "<fifo>",
    "--pcm-gain", String(pcmGain),
    "--mode", mode,
    "--metrics", path.resolve(REPO_ROOT, metrics),
    "--summary", path.resolve(REPO_ROOT, summary)
  ];
  const contextText = stringOrDefault(args.contextText, "");
  if (contextText) command.push("--context-text", contextText);

  if (dryRun) {
    return {
      ...base,
      canSend: selectedTtsProvider === "api-key" ? Boolean(process.env.VOLC_SPEECH_API_KEY) : Boolean(appId && accessToken),
      command,
      nextSteps: ["Call speak_stream_intent again with dryRun=false to stream TTS to ESP32."]
    };
  }

  if (selectedTtsProvider === "api-key" && !process.env.VOLC_SPEECH_API_KEY) {
    return {
      ...base,
      ok: false,
      error: "VOLC_SPEECH_API_KEY is not set",
      nextSteps: ["Set VOLC_SPEECH_API_KEY in the Claude Code/MCP environment, then retry."]
    };
  }
  if (selectedTtsProvider === "legacy-ws" && (!appId || !accessToken)) {
    return {
      ...base,
      ok: false,
      error: "VOLC_TTS_APP_ID and VOLC_TTS_ACCESS_TOKEN are not set",
      nextSteps: ["Set legacy Volcengine Speech Console credentials, then retry."]
    };
  }

  await mkdir(path.join(REPO_ROOT, "MCP", "runs"), { recursive: true });
  const timeoutSeconds = numberOrDefault(args.timeoutSeconds, 240, 10, 900);
  const send = useDirectMqttApiKey
    ? await runCommand(command[0], command.slice(1), {
      cwd: REPO_ROOT,
      timeoutSeconds,
      allowFailure: true
    })
    : await runFifoTtsStream({
      text,
      selectedTransport,
      selectedTtsProvider,
      resourceId,
      speaker,
      voiceType,
      appId,
      accessToken,
      cluster,
      language,
      volumeRatio,
      pcmGain,
      speedRatio,
      pitchRatio,
      loudnessRate,
      contextText,
      broker,
      deviceId,
      bleDevice,
      adapter,
      mode,
      metrics: path.resolve(REPO_ROOT, metrics),
      summary: path.resolve(REPO_ROOT, summary),
      timeoutSeconds
    });
  const parsed = parseLastJson(send.stdout);
  return {
    ...base,
    ok: send.code === 0 && parsed?.ok === true,
    command,
    send: {
      code: send.code,
      summary: parsed,
      stdout: redactSensitive(trimOutput(send.stdout)),
      stderr: redactSensitive(trimOutput(send.stderr))
    },
    error: send.code === 0 ? null : redactSensitive(trimOutput(send.stderr || send.stdout))
  };
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "***";
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function parseLastJson(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

async function runFifoTtsStream({
  text,
  selectedTransport,
  selectedTtsProvider,
  resourceId,
  speaker,
  voiceType,
  appId,
  accessToken,
  cluster,
  language,
  volumeRatio,
  pcmGain,
  speedRatio,
  pitchRatio,
  loudnessRate,
  contextText,
  broker,
  deviceId,
  bleDevice,
  adapter,
  mode,
  metrics,
  summary,
  timeoutSeconds
}) {
  const tempDir = await mkdtemp(path.join(REPO_ROOT, "MCP", "runs", `${selectedTransport}-tts-`));
  const fifoPath = path.join(tempDir, "tts.mp3");
  const ttsSummary = path.join(tempDir, "tts-summary.json");
  await runCommand("mkfifo", [fifoPath], { cwd: REPO_ROOT, timeoutSeconds: 5 });

  const ttsArgs = [
    path.join(REPO_ROOT, "scripts", "volc_tts_mp3_stream.py"),
    "--text", text,
    "--output", fifoPath,
    "--provider", selectedTtsProvider,
    "--resource-id", resourceId,
    "--speaker", speaker,
    "--voice-type", voiceType,
    "--app-id", appId,
    "--access-token", accessToken,
    "--cluster", cluster,
    "--language", language,
    "--volume-ratio", String(volumeRatio),
    "--speed-ratio", String(speedRatio),
    "--pitch-ratio", String(pitchRatio),
    "--loudness-rate", String(loudnessRate),
    "--summary", ttsSummary
  ];
  if (contextText) ttsArgs.push("--context-text", contextText);

  const sendArgs = selectedTransport === "mqtt" ? [
    path.join(REPO_ROOT, "scripts", "mqtt_audio_stream.py"),
    "--broker", broker,
    "--device-id", deviceId,
    "--input", fifoPath,
    "--pcm-gain", String(pcmGain),
    "--mode", mode,
    "--metrics", metrics,
    "--summary", summary
  ] : [
    path.join(REPO_ROOT, "scripts", "ble_audio_stream.py"),
    "--device", bleDevice,
    "--adapter", adapter,
    "--input", fifoPath,
    "--pcm-gain", String(pcmGain),
    "--mode", mode,
    "--metrics", metrics,
    "--summary", summary
  ];

  let ttsStdout = "";
  let ttsStderr = "";
  let sendStdout = "";
  let sendStderr = "";
  const tts = spawn("python3", ttsArgs, { cwd: REPO_ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  const sender = spawn("python3", sendArgs, { cwd: REPO_ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });

  tts.stdout.on("data", (chunk) => { ttsStdout += chunk.toString("utf8"); });
  tts.stderr.on("data", (chunk) => { ttsStderr += chunk.toString("utf8"); });
  sender.stdout.on("data", (chunk) => { sendStdout += chunk.toString("utf8"); });
  sender.stderr.on("data", (chunk) => { sendStderr += chunk.toString("utf8"); });

  const started = Date.now();
  const timer = setTimeout(() => {
    tts.kill("SIGTERM");
    sender.kill("SIGTERM");
    setTimeout(() => {
      tts.kill("SIGKILL");
      sender.kill("SIGKILL");
    }, 1000).unref();
  }, timeoutSeconds * 1000);

  const waitChild = (child) => new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: 127, error: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 0 }));
  });

  const [ttsResult, sendResult] = await Promise.all([waitChild(tts), waitChild(sender)]);
  clearTimeout(timer);
  await rm(tempDir, { recursive: true, force: true });

  const code = sendResult.code === 0 && ttsResult.code === 0 ? 0 : (sendResult.code || ttsResult.code || 1);
  return {
    code,
    stdout: sendStdout,
    stderr: [
      ttsResult.error ? `tts error: ${ttsResult.error}` : "",
      sendResult.error ? `sender error: ${sendResult.error}` : "",
      ttsStderr ? `tts stderr:\n${ttsStderr}` : "",
      sendStderr ? `sender stderr:\n${sendStderr}` : "",
      code !== 0 && Date.now() - started >= timeoutSeconds * 1000 ? "timed out" : ""
    ].filter(Boolean).join("\n")
  };
}

function trimOutput(text, limit = 12000) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...<truncated ${value.length - limit} chars>`;
}

function redactSensitive(text) {
  const appId = process.env.VOLC_TTS_APP_ID || "";
  const accessToken = process.env.VOLC_TTS_ACCESS_TOKEN || "";
  const speechKey = process.env.VOLC_SPEECH_API_KEY || "";
  let value = String(text || "");
  for (const secret of [appId, accessToken, speechKey].filter(Boolean)) {
    value = value.split(secret).join(maskSecret(secret));
  }
  return value;
}

function runCommand(command, args, options = {}) {
  const timeoutSeconds = numberOrDefault(options.timeoutSeconds, 30, 1, 3600);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (options.allowFailure) {
        resolve({ code: 127, stdout, stderr: stderr || error.message });
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = { code: code ?? 0, stdout, stderr };
      if (!options.allowFailure && result.code !== 0) {
        reject(new Error(stderr || stdout || `${command} exited with ${result.code}`));
        return;
      }
      resolve(result);
    });
  });
}
