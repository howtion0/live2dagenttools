# TALKMCP 施工文档

目标：提供一个 Claude Code 可装载的 MCP 工具，让 agent 在需要语音输出时把“要说的话”作为 `text` 调用 `speak_stream_intent`，由 TALKMCP 内部完成火山引擎流式 TTS 和 ESP32 WiFi/BLE 流式播放。

## 边界

- `text` 只表示要合成为语音的可见文本，不解析为命令。
- 控制命令、文件播放、诊断和连接操作必须走单独工具，不能塞进 `text`。
- 隐藏思考过程、日志、工具结果、JSON、shell 命令默认不进入 TTS。
- 语音是旁路输出：CLI 上的正常文字回答必须完整保留。普通问答可播一句短摘要；代码、补丁、日志、命令输出、JSON、表格、路径只播短里程碑。
- 真实音频优先走 WiFi/MQTT；如果 WiFi 不可用且 BLE 已连接，则走 FIFO 生产消费模型接入现有 BLE sender。

## 主链路

```text
Claude Code
  -> speak_stream_intent({ text, transport:auto, dryRun:false })
      -> check_runtime_connections
      -> select mqtt when broker is reachable
      -> Volcengine TTS producer (legacy websocket or API-key HTTP)
      -> ffmpeg transcode to 16k mono s16le, with optional TALKMCP_PCM_GAIN
      -> ESP32 MQTT audio consumer with ACK/backpressure
      -> END + drain wait
```

BLE 分支：

```text
Claude Code
  -> speak_stream_intent({ text, transport:ble })
      -> Volcengine HTTP Chunked TTS producer
      -> FIFO mp3 stream
      -> existing ble_audio_stream.py ffmpeg consumer, with optional TALKMCP_PCM_GAIN
      -> ESP32 BLE characteristic with ACK/backpressure
```

## 火山配置

环境变量：

- `VOLC_SPEECH_API_KEY`: API-key TTS 模式需要。
- `VOLC_TTS_RESOURCE_ID`: 默认 `seed-tts-2.0`。复刻音色使用 `seed-icl-2.0`。
- `VOLC_TTS_SPEAKER`: 默认官方测试音色；复刻音色填 `S_...` 或 `icl_...`。
- `VOLC_TTS_LANGUAGE`: 默认 `zh-cn`。
- `VOLC_TTS_VOLUME_RATIO`: 默认 `3.0`，火山 TTS 音量倍率。
- `TALKMCP_PCM_GAIN`: 默认 `3.0`，本地 ffmpeg PCM 数字增益，过大可能削波，破音时降低。
- `VOLC_TTS_SPEED_RATIO` / `VOLC_TTS_PITCH_RATIO` / `VOLC_TTS_LOUDNESS_RATE`: 语速、音高和响度参数。
- 旧版 websocket 可用 `VOLC_TTS_PROVIDER=legacy-ws`、`VOLC_TTS_APP_ID`、`VOLC_TTS_ACCESS_TOKEN`、`VOLC_TTS_CLUSTER`、`VOLC_TTS_VOICE_TYPE`。

请求接口：

- URL: `https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- Header: `X-Api-Key`, `X-Api-Resource-Id`, `X-Api-Request-Id`
- Body: `req_params.text`, `req_params.speaker`, `audio_params.format=mp3`, `sample_rate=24000`

旧版 websocket：

- URL: `wss://openspeech.bytedance.com/api/v1/tts/ws_binary`
- Header: `Authorization: Bearer;{access_token}`
- Body: gzip JSON，包含 `app.appid`、`app.cluster`、`audio.voice_type`、`request.text`

## MCP 工具

### `speak_stream_intent`

主工具。输入字面 TTS 文本，自动检查连接并选择 transport。

- `text`: 必填，要说的话。
- `transport`: `auto | mqtt | ble`，默认 `auto`。
- `dryRun`: 默认 `true`。
- `profile`: 默认 `live2d-atri`。
- `broker`: 可覆盖 MQTT broker。
- `deviceId`: 可覆盖 ESP32 deviceId。
- `speaker`, `resourceId`, `language`: 可覆盖火山 TTS 配置。
- `ttsProvider`: `auto | api-key | legacy-ws`。`auto` 优先使用 `VOLC_SPEECH_API_KEY`，否则使用 legacy AppID/Access Token。
- `volumeRatio`: 火山 TTS 音量倍率，默认 `3.0`。
- `pcmGain`: ffmpeg PCM 增益，默认 `3.0`，用于 ESP32 播放端继续放大。
- `speedRatio`, `pitchRatio`, `loudnessRate`: 可覆盖语音参数。

### `check_runtime_connections`

检查 MQTT broker TCP 可达性和 BlueZ/BLE 基础状态。

### `connection_mode_help`

当 WiFi/MQTT 和 BLE 都不可用时，返回用户需要确认的连接步骤。

## 验收

1. `node MCP/call-tool.js tools/list` 能看到 `speak_stream_intent`。
2. `speak_stream_intent` dry-run 能返回将使用的 TTS 和 transport。
3. 没有 API Key 且没有 legacy AppID/Access Token 时，真实调用会明确失败在配置检查，不会假成功。
4. MQTT 可达且 ESP32 在线时，真实调用返回 `drainComplete=true`。
5. schema 会拒绝 `text` 之外的未知操作字段，例如 `command`。
