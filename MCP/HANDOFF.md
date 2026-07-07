# live2dagenttools MCP Handoff

This MCP layer lets Claude choose a Live2D ESP32 target, resolve audio, inspect
BLE/WiFi readiness, dry-run or send audio, publish/listen to MQTT control topics,
and read/write serial diagnostics without changing ESP32 firmware.

## Current Target

Default profile: `live2d-atri`

```text
profile:           live2d-atri
deviceId:          live2d-atri
wifi ssid:         FMai
configured broker: mqtt://192.168.11.73:1883
suggested broker:  mqtt://192.168.11.73:1883
ble name:          esplive2d
ble device:        28:84:85:90:B2:2E
adapter:           hci0
serial:            /dev/ttyACM0
audio roots:       /run/media/howtion/thinkplus/1.8/测试音频
                   /run/media/howtion/thinkplus/1.8
```

Profiles live in `MCP/profiles.json`. Explicit tool arguments override profile
defaults.

## Main Claude Tools

- `list_device_profiles`: choose a target profile.
- `validate_device_profiles`: check profile structure and optional runtime readiness.
- `integration_status`: compact handoff/status report for Claude.
- `diagnose_wifi_mqtt`: WiFi/MQTT-specific broker, route, serial, and topic diagnosis.
- `play_audio_intent`: resolve an audio name/path and choose `auto`, `mqtt`, or `ble`.
- `smoke_test_transports`: safe readiness matrix; does not send real audio unless `realSend: true`.
- `prepare_transport`: lower-level BLE/MQTT readiness check plus send command.
- `send_audio`: actual one-file BLE/MQTT audio send using existing sender scripts.
- `batch_send_audio`: actual batch BLE/MQTT audio send.
- `send_control_command`: send command text over MQTT, BLE, or serial.
- `switch_transport_mode`: send `mode:mqtt`, `mode:ble`, `cancel`, etc., and verify logs if possible.
- `listen_mqtt_topics`: subscribe to `state`, `cmd`, or `audio/status`.
- `read_esp32_serial`: read ESP32 serial logs.

## Local Commands

```bash
npm run mcp:profiles
MCP_PROFILE_READINESS=1 npm run mcp:profiles
npm run mcp:smoke
npm run mcp:call -- diagnose_wifi_mqtt '{"profile":"live2d-atri","audio":"ATR_b102_015","candidateBrokers":["mqtt://192.168.11.73:1883"]}'
npm run mcp:claude-smoke
npm run mcp:selftest
npm run typecheck
claude mcp get live2dagenttools
```

`npm run mcp:smoke` exits:

- `0`: at least one real audio transport is ready.
- `2`: MCP tooling works, but current runtime is not ready for real audio.

## Current Runtime Result

MCP and Claude integration are working:

- MCP server initializes and exposes tools over stdio.
- Claude connects through `.mcp.json`.
- Audio file lookup works.
- Device profile lookup and validation work.
- Local mosquitto on `127.0.0.1:1883` accepts MQTT CONNACK.
- MQTT publish/subscribe plumbing works locally.
- Serial read path works on `/dev/ttyACM0`.
- BLE adapter `hci0` exists and is not rfkill-blocked.

Real audio playback status:

- BLE real send is proven: `ATR_b102_015.wav` sent successfully to
  `28:84:85:90:B2:2E`, `190080` bytes, drain complete.
- WiFi/MQTT real send is proven after updating ESP32 broker to
  `mqtt://192.168.11.73:1883`: `ATR_b102_015.wav` sent successfully,
  `190080` bytes, drain complete.
- WiFi/MQTT long MP3 streaming is proven with the ESP32 audio starvation fix:
  `/run/media/howtion/thinkplus/1.8/测试音频/04.mp3` is a `256.7` second,
  `16 kHz`, mono MP3 that decodes to `8214640` bytes of PCM. Direct tools
  (`scripts/mqtt_audio_stream.py`) passed with `finalReceived=8214640`,
  `finalRead=8214640`, `finalFill=0`, `drainComplete=true`. MCP `send_audio`
  also passed with the same final counters. `statusStallTimeout` remains a
  regression guard so future ESP32-side stalls fail clearly instead of waiting
  for the outer timeout.
- WiFi/MQTT association is proven after pressing PWR:
  `wifi connected ssid=FMai ip=192.168.11.159`.
- WiFi/MQTT broker is proven:
  `mqtt connected broker=mqtt://192.168.11.73:1883`.
- Serial mode-switch writes complete, but current logs do not prove firmware
  acts on serial `mode:*` commands.

## Next Runtime Steps

For WiFi/MQTT:

1. Keep local mosquitto running on this machine.
2. Current ESP32 firmware auto-starts BLE/WiFi about 8 seconds after boot. Press
   ESP32 `PWR` only when you want to start/reconnect immediately.
3. Ensure ESP32 broker configuration points to this machine's LAN broker:
   `mqtt://192.168.11.73:1883`.
4. Re-run:

```bash
npm run mcp:call -- diagnose_wifi_mqtt '{"profile":"live2d-atri","audio":"ATR_b102_015","candidateBrokers":["mqtt://192.168.11.73:1883"]}'
npm run mcp:smoke
npm run mcp:claude-smoke
```

5. When smoke reports `readyForRealAudio: true`, call `play_audio_intent` with
   `dryRun: false`.

6. For long audio such as `04.mp3`, use `statusStallTimeout` as a guard. Passing
   evidence is in `MCP/runs/tools-04-after-fix.json` and
   `MCP/runs/mcp-04-after-fix.json`.

For BLE:

1. Start BlueZ with system privileges:

```bash
sudo systemctl start bluetooth
```

2. Put the ESP32 in BLE/WiFi connection mode if needed.
3. Re-run smoke.
4. When BLE is ready, call `play_audio_intent` with `transport: "ble"` and
   `dryRun: false`.

## Safe Claude Prompt

```text
Use live2dagenttools MCP. Call integration_status with profile live2d-atri,
audio ATR_b102_015, includeReadiness true. If readyForRealAudio is true, call
play_audio_intent with the ready transport and dryRun false. Otherwise summarize
the blockers and do not send audio.
```
