# TALKMCP

TALKMCP is an MCP server for Claude Code that streams Volcengine TTS speech to a Live2D ESP32 target.

## Setup

```bash
cd /path/to/TALKMCP
export VOLC_SPEECH_API_KEY="your-api-key"
export VOLC_TTS_RESOURCE_ID="seed-tts-2.0"
export VOLC_TTS_SPEAKER="zh_female_shuangkuaisisi_moon_bigtts"
export VOLC_TTS_LANGUAGE="zh-cn"
export VOLC_TTS_VOLUME_RATIO="3.0"
export TALKMCP_PCM_GAIN="3.0"
```

`VOLC_TTS_VOLUME_RATIO` controls the Volcengine voice volume. `TALKMCP_PCM_GAIN`
is an extra local ffmpeg PCM gain applied before streaming to the ESP32; lower it
if the speaker clips or distorts.

For cloned voices, use:

```bash
export VOLC_TTS_RESOURCE_ID="seed-icl-2.0"
export VOLC_TTS_SPEAKER="S_xxxxx_or_icl_xxxxx"
```

For legacy Speech Console AppID/Access Token:

```bash
export VOLC_TTS_PROVIDER="legacy-ws"
export VOLC_TTS_APP_ID="your-app-id"
export VOLC_TTS_ACCESS_TOKEN="your-access-token"
export VOLC_TTS_CLUSTER="volcano_tts"
export VOLC_TTS_VOICE_TYPE="zh_female_shuangkuaisisi_moon_bigtts"
```

Local credentials can also be stored in `.env`. This file is ignored by Git; use
`.env.example` as the public template.

## Test

```bash
npm run check
npm run smoke
node MCP/call-tool.js tools/list
node MCP/call-tool.js check_runtime_connections '{"profile":"live2d-atri"}'
node MCP/call-tool.js speak_stream_intent '{"text":"这是 TALKMCP 的流式语音测试。","dryRun":true}'
```

Real send:

```bash
node MCP/call-tool.js speak_stream_intent '{"text":"这是 TALKMCP 的流式语音测试。","transport":"auto","dryRun":false,"timeoutSeconds":240}'
```

Claude Code real voice session after API key is configured:

```bash
npm run voice:ask -- "请用语音告诉我现在连接状态。"
```

## Claude Code

Load `.mcp.json` from this directory:

```bash
claude -p --mcp-config .mcp.json --strict-mcp-config
```

The main tool is `speak_stream_intent`.

Voice-session wrapper:

```bash
npm run voice:ask -- "请用语音告诉我现在连接状态"
npm run voice:session
```

The wrapper injects `MCP/voice-session-prompt.md`. In voice mode, TALKMCP is a
side-channel: normal CLI text must remain complete, while ordinary conversational
answers also play one short spoken summary. Coding, logs, commands, JSON, tables,
file paths, and patches are not spoken; only short milestones are spoken.

Hot-plug Claude Code command:

```bash
claude \
  --mcp-config "$PWD/.mcp.json" \
  --strict-mcp-config \
  --permission-mode bypassPermissions \
  "$(cat "$PWD/MCP/voice-session-prompt.md")"
```

One-shot:

```bash
claude -p \
  --mcp-config "$PWD/.mcp.json" \
  --strict-mcp-config \
  --permission-mode bypassPermissions \
  "$(cat "$PWD/MCP/voice-session-prompt.md")

User request:
请用语音告诉我现在连接状态"
```
