# live2dagenttools MCP

This directory contains a stdio MCP server for Claude Code. It wraps the existing
`live2dagenttools` sender scripts instead of duplicating the BLE/MQTT protocol.

## Tools

- `list_audio_files`: find supported audio files.
- `probe_audio`: inspect a file with `ffprobe`.
- `scan_ble_devices`: run the existing BlueZ BLE scan path.
- `check_mqtt_broker`: check MQTT 3.1.1 CONNECT/CONNACK for a `mqtt://host:port` broker.
- `listen_mqtt_topics`: briefly subscribe to MQTT state, command, or audio/status topics.
- `diagnose_runtime`: collect local network, broker, BlueZ, and ESP32 serial state.
- `diagnose_wifi_mqtt`: WiFi/MQTT-specific diagnosis for broker candidates, routes, serial evidence, topic listen, and send command.
- `list_runtime_targets`: show known device IDs, MQTT topics, BLE UUIDs, audio roots, and readiness hints.
- `list_device_profiles`: list named target profiles from `MCP/profiles.json`.
- `validate_device_profiles`: validate profile structure, duplicates, paths, serial ports, and broker URI shape.
- `start_local_mqtt_broker`: start a local mosquitto broker for WiFi/MQTT tests.
- `stop_local_mqtt_broker`: stop only the mosquitto process started from `MCP/runs/mosquitto.conf`.
- `prepare_transport`: validate readiness and return exact next steps before sending.
- `play_audio_intent`: resolve an audio name/path, choose `auto`/`mqtt`/`ble`, check readiness, then dry-run or send.
- `smoke_test_transports`: run a safe readiness matrix across audio selection, MQTT, BLE, serial, and optional real send.
- `integration_status`: concise Claude/handoff report covering profiles, smoke checks, blockers, and commands.
- `send_audio`: send one file over `ble` or `mqtt`.
- `batch_send_audio`: send a file list or directory over `ble` or `mqtt`.
- `read_esp32_serial`: read short ESP32 serial logs.
- `send_control_command`: send `ping`, `wave`, `motion:*`, `speak:*`, or raw text over BLE, MQTT, or serial.
- `switch_transport_mode`: ask ESP32 to prefer BLE, WiFi/MQTT, auto, or cancel via serial/BLE/MQTT control.

`send_audio` and `batch_send_audio` accept `dryRun: true` so Claude can inspect
the exact command before transmitting audio.

For MQTT sends, `send_audio`, `batch_send_audio`, and `play_audio_intent` also
accept `statusStallTimeout` in seconds. This fails a stream when ESP32
`audio/status` stops advancing while bytes remain buffered, so Claude gets a
clear ESP32-side stall error instead of waiting for the outer command timeout.

For normal Claude use, prefer `play_audio_intent` first. It lets Claude say
"play ATR_b102_015 over auto/mqtt/ble" without manually resolving the file path
or deciding whether the current broker/BlueZ state is ready.

For development verification, run `smoke_test_transports`. It does not send real
audio unless `realSend: true` is explicitly set.

## Claude Code

From the repository root:

```bash
claude mcp add live2dagenttools -- node /run/media/howtion/thinkplus/1.8/live2dagenttools/MCP/server.js
claude mcp get live2dagenttools
```

Or use the project config:

```bash
claude mcp list
```

## Local Protocol Test

```bash
node MCP/test-client.js
```

Expected result: initialize succeeds, tools are listed, local audio files are
reported, a local MQTT broker accepts CONNACK, MQTT subscribe works, MQTT
control publish works, and a dry-run MQTT audio command is returned.

Concise transport smoke summary:

```bash
npm run mcp:smoke
```

`mcp:smoke` exits `0` when a real audio transport is ready and `2` when the MCP
tooling works but the current environment is not ready for real audio. Override
defaults with `MCP_SMOKE_AUDIO`, `MCP_SMOKE_BROKER`, `MCP_SMOKE_DEVICE_ID`,
`MCP_SMOKE_PROFILE`, `MCP_SMOKE_BLE_DEVICE`, `MCP_SMOKE_SERIAL_PORT`, and
`MCP_SMOKE_REAL_SEND=1`.
`MCP_SMOKE_PROFILE` supplies broker/device/BLE/serial defaults first; the other
environment variables override only the fields they name.

Profile validation:

```bash
npm run mcp:profiles
MCP_PROFILE_READINESS=1 npm run mcp:profiles
```

Without `MCP_PROFILE_READINESS=1`, this checks profile structure only. With it,
the same command also reports current broker/BlueZ readiness warnings.

Direct MCP tool calls without Claude:

```bash
npm run mcp:call -- diagnose_wifi_mqtt '{"profile":"live2d-atri","audio":"ATR_b102_015","candidateBrokers":["mqtt://192.168.11.73:1883"]}'
npm run mcp:call -- send_audio '{"transport":"mqtt","input":"/run/media/howtion/thinkplus/1.8/测试音频/ATR_b102_015.wav","broker":"mqtt://192.168.11.73:1883","deviceId":"live2d-atri"}'
```

Claude integration smoke:

```bash
npm run mcp:claude-smoke
```

This runs local Claude against `.mcp.json` and allows only
`mcp__live2dagenttools__smoke_test_transports`. It verifies Claude can invoke the
MCP server and interpret the transport matrix. It does not send real audio unless
`MCP_SMOKE_REAL_SEND=1` is set.

## Examples

MQTT dry run:

```json
{
  "transport": "mqtt",
  "input": "/run/media/howtion/thinkplus/1.8/测试音频/ATR_b102_015.wav",
  "broker": "mqtt://192.168.11.73:1883",
  "deviceId": "live2d-atri",
  "mode": "pi",
  "dryRun": true
}
```

MQTT readiness check before a real send:

```json
{
  "transport": "mqtt",
  "input": "/run/media/howtion/thinkplus/1.8/测试音频/ATR_b102_015.wav",
  "broker": "mqtt://192.168.11.73:1883",
  "deviceId": "live2d-atri",
  "serialSeconds": 2
}
```

WiFi/MQTT diagnosis:

```json
{
  "profile": "live2d-atri",
  "broker": "mqtt://192.168.11.73:1883",
  "candidateBrokers": ["mqtt://192.168.11.73:1883"],
  "audio": "ATR_b102_015",
  "serialSeconds": 5,
  "listenSeconds": 5
}
```

Target discovery before choosing a route:

```json
{
  "broker": "mqtt://192.168.11.73:1883",
  "deviceId": "live2d-atri",
  "audioLimit": 12
}
```

High-level playback intent:

```json
{
  "audio": "ATR_b102_015",
  "profile": "live2d-atri",
  "transport": "auto",
  "broker": "mqtt://192.168.11.73:1883",
  "deviceId": "live2d-atri",
  "bleDevice": "28:84:85:90:B2:2E",
  "mode": "pi",
  "dryRun": true
}
```

Safe transport smoke test:

```json
{
  "audio": "ATR_b102_015",
  "profile": "live2d-atri",
  "broker": "mqtt://192.168.11.73:1883",
  "deviceId": "live2d-atri",
  "bleDevice": "28:84:85:90:B2:2E",
  "realSend": false
}
```

Integration handoff status:

```json
{
  "profile": "live2d-atri",
  "audio": "ATR_b102_015",
  "includeReadiness": true
}
```

Device profiles:

```json
{
  "profile": "live2d-atri"
}
```

Profiles live in `MCP/profiles.json`. Explicit tool arguments override profile
defaults, so Claude can say "use live2d-atri but try this broker" without editing
the profile file.
Run `validate_device_profiles` after editing profiles. With `includeReadiness:
false` it checks configuration shape only; with `includeReadiness: true` it also
adds current broker/BlueZ warnings.

## Runtime Notes

WiFi/MQTT real playback needs both sides on the same broker:

- The ESP32 firmware connects to its compiled broker URI.
- Claude/MCP `send_audio` must publish to that same broker.
- This firmware path does not auto-discover a broker by LAN broadcast; use a
  matching broker URI, router forwarding, or a firmware/config update.
- `check_mqtt_broker` verifies an MQTT CONNACK, not just TCP reachability.
- `start_local_mqtt_broker` can start mosquitto on this machine, but ESP32 must
  be configured to connect to this machine's LAN IP for playback to work.
- Long streams can expose ESP32-side audio starvation even when short WAV files
  pass. `04.mp3` decodes to several MB of PCM; if its `read` counter stops while
  `fill` stays high, the problem is ESP32 audio consumption/state cleanup, not
  ffmpeg or MCP command framing.
- `stop_local_mqtt_broker` refuses to stop unrelated brokers on the same port.

BLE real playback needs BlueZ:

- `scan_ble_devices` and BLE `send_audio` use the existing BlueZ D-Bus sender.
- `diagnose_runtime` reports whether `bluetooth.service`, `hci0`, and rfkill are
  ready.
- If BlueZ is inactive, start it outside MCP with system privileges, then press
  the ESP32 `PWR` key to enter BLE/WiFi connection mode.

Control commands:

- MQTT control publishes UTF-8 text to `live2d/{deviceId}/cmd`.
- MQTT listening can watch `live2d/{deviceId}/state` and
  `live2d/{deviceId}/audio/status`; `audio/status` is decoded into
  `free/fill/received/read/highWater/active/finished`.
- BLE control uses the existing `npm run cli -- send --device ... --message ...` path.
- Serial control writes raw text plus newline to the serial port. This is useful
  for future firmware console hooks, but current firmware must implement a
  serial command parser for serial writes to affect BLE/WiFi state.
- `switch_transport_mode` reports `sentOk` separately from `effectVerified`.
  Treat `effectVerified: false` as a real result: the command was sent, but ESP32
  logs/state did not prove a mode switch.

BLE dry run:

```json
{
  "transport": "ble",
  "input": "/run/media/howtion/thinkplus/1.8/测试音频/ATR_b102_015.wav",
  "bleDevice": "28:84:85:90:B2:2E",
  "adapter": "hci0",
  "mode": "pi",
  "dryRun": true
}
```
