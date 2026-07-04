# Live2D ESP32 WiFi/MQTT Gateway 施工文档

版本：`1.4.2-v2`
起点：tools `v1.1` 已推送到 GitHub，提交 `71bc2d7`
当前硬件目标：Waveshare ESP32-S3-Touch-AMOLED-1.8 V2。V1 记录保留；当前 GitHub tag/release 使用 V2 后缀。

## 目标

在不破坏现有 BLE 音频链路的前提下，为 `live2dagenttools` 和 `live2desp32agent` 增加一条 WiFi/MQTT gateway 通道。

要求：

- BLE 和 WiFi/MQTT 两条链路解耦开发。
- 运行时只选择一个链路工作：一旦 BLE 或 WiFi/MQTT 成功建立工作会话，另一条链路不再开始新的发送任务。
- V2 固件中 BLE gateway 和 WiFi/MQTT gateway 都存在；ESP32 `remote_gateway` 维护 owner，PC sender 通过 ACK/status 背压控制发包。
- 现有 BLE 的 `watermark` 压降法和 `pi` 控制法继续可用。
- WiFi/MQTT 复用同一套音频流语义、ACK/status 字段和 PC 端控制器。
- ffmpeg 仍然是生产者；发送端仍然是消费者；ESP32 ring/I2S DMA 播放不改语义。
- 迁移既有 BLE 测试到 WiFi/MQTT，并记录完整测试结果。

## 凭据和配置

开发测试 WiFi：

```text
ssid: FMai
password: 147258147258
```

实现约束：

- tools 端使用环境变量或 GUI 配置项传入 broker/主题/凭据。
- ESP32 端通过 Kconfig 或构建配置传入 WiFi/MQTT 参数。
- 不把 WiFi 密码散落硬编码到协议逻辑里。

建议环境变量：

```bash
LIVE2D_WIFI_SSID=FMai
LIVE2D_WIFI_PASSWORD=147258147258
LIVE2D_MQTT_BROKER=mqtt://192.168.x.x:1883
LIVE2D_MQTT_DEVICE=live2d-atri
```

## MQTT Topic 设计

默认 device id：`live2d-atri`

```text
live2d/{device}/cmd          PC -> ESP32，文本命令
live2d/{device}/audio/in     PC -> ESP32，二进制音频包
live2d/{device}/audio/status ESP32 -> PC，二进制 ACK/status
live2d/{device}/state        ESP32 -> PC，在线/会话状态 JSON
```

二进制音频包保持和 BLE DATA characteristic 一致：

```text
START:
  byte 0      : 0x01
  byte 1..4   : total_hint_le_u32, unknown = 0
  byte 5..6   : sample_rate_le_u16, current 16000
  byte 7      : channels, current 1
  byte 8      : format, current 1 = s16le mono

DATA:
  byte 0      : 0x02
  byte 1..2   : seq_le_u16
  byte 3..N   : PCM payload

END:
  byte 0      : 0x03

CANCEL:
  byte 0      : 0x04
```

ACK/status 保持和 BLE status notify 一致：

```text
byte 0       : 0x10
byte 1..4    : free_le_u32
byte 5..8    : fill_le_u32
byte 9..12   : received_le_u32
byte 13..16  : read_le_u32
byte 17..20  : high_water_le_u32
byte 21      : active
byte 22      : finished
```

## 运行模型

```text
PC ffmpeg streaming producer
  -> transport-agnostic sender
  -> watermark ACK 或 PC-side PI 控制 send budget
  -> BLE GATT audio write 或 MQTT audio/in publish
  -> ESP32 gateway parser
  -> remote_dispatch audio ring
  -> audio task consumes ring
  -> I2S DMA / ES8311 / speaker
```

BLE/WiFi 互斥规则：

```text
IDLE:
  BLE connected and starts audio -> owner = BLE
  MQTT connected and starts audio -> owner = MQTT

owner = BLE:
  MQTT audio START is rejected or ignored
  BLE disconnect/cancel/end-drained releases owner

owner = MQTT:
  BLE audio START is rejected or ignored
  MQTT disconnect/cancel/end-drained releases owner
```

## Tools 改造计划

1. 抽象音频发送 transport：
   - `BleAudioTransport` 复用现有 BlueZ/Python BLE 逻辑。
   - `MqttAudioTransport` 发布 `audio/in`，订阅 `audio/status`。
   - 两者暴露同一组 `writePacket()` / `onStatus()` / `close()`。

2. 复用控制器：
   - watermark 计算不变。
   - PI 计算不变。
   - 控制器只依赖 ACK/status，不关心底层是 BLE 还是 MQTT。

3. CLI：
   - `scripts/ble_audio_stream.py` 保持兼容。
   - 新增 `scripts/mqtt_audio_stream.py` 或统一 `scripts/audio_stream.py --transport ble|mqtt`。

4. Electron GUI：
   - 新增 transport 选择：BLE / WiFi MQTT。
   - BLE 选择蓝牙设备。
   - MQTT 配置 broker、device id。
   - 若一个 transport 正在发送，另一个开始按钮禁用。

## ESP32 改造计划

1. 新增 `components/remote_gateway`：
   - 抽出 BLE 现有音频包解析状态机。
   - 提供 `remote_gateway_audio_packet(source, data, len)`。
   - 提供 `remote_gateway_encode_status()`。

2. 保留 `remote_wireless`：
   - GATT UUID、BLE 行为保持不变。
   - BLE 收到包后调用 gateway parser。
   - BLE status notify 使用统一 status encoder。

3. 新增 `components/gateway_wifi`：
   - WiFi STA 连接。
   - MQTT connect/subscribe。
   - `cmd` topic -> `remote_protocol_parse_text()` -> `remote_dispatch_command()`。
   - `audio/in` topic -> gateway parser -> `remote_dispatch_audio_stream_*()`。
   - dispatch status callback -> `audio/status` publish。

4. 互斥：
   - gateway 持有当前 owner。
   - owner 冲突时拒绝 START。
   - cancel/disconnect/播放完成释放 owner。

## 测试迁移

BLE 既有基线：

```text
03.mp3 watermark: 8387334 bytes / 46597 packets / 260.46 s
03.mp3 pi:        8387334 bytes / 46597 packets / 260.69 s
```

WiFi/MQTT 要跑同一批：

```text
3 秒 03.mp3 smoke / watermark
3 秒 03.mp3 smoke / pi
完整 03.mp3 / watermark
完整 03.mp3 / pi
互斥测试：BLE 发送中 MQTT START 被拒绝
互斥测试：MQTT 发送中 BLE START 被拒绝
断线测试：MQTT 断开后 ESP32 cancel/release owner
```

记录字段：

```text
bytes
packets
duration
averageBytesPerSecond
statusUpdates
finalFree/finalFill/finalReceived/finalRead/highWater
ESP32 serial log
metrics csv/json
```

## 开发日志

### 2026-06-25 22:xx

- 已推送 tools `v1.1` 到 GitHub。
- 已确认 ESP32 当前 `remote_dispatch` 保存环形缓冲、ACK 状态和播放读侧。
- 已确认 BLE 当前 `remote_wireless` 只负责 GATT 收包、解析和 status notify。
- 决定新增 MQTT gateway，不改 `remote_dispatch` 的音频生产消费语义。

### 2026-06-25 22:xx tools MQTT sender

- 新增 `scripts/mqtt_audio_stream.py`。
- 新增 `npm run audio:mqtt`。
- MQTT sender 复用 BLE 的 START/DATA/END/CANCEL 和 ACK/status 字节布局。
- MQTT sender 复用 watermark 和 PI 控制器。
- MQTT sender 使用无第三方依赖的 MQTT 3.1.1 TCP QoS0 最小客户端。
- 默认 topic 为 `live2d/{device}/audio/in` 和 `live2d/{device}/audio/status`。

### 2026-06-25 22:xx Electron MQTT UI

- Electron GUI 新增 BLE / WiFi MQTT transport 选择。
- BLE transport 保持扫描蓝牙设备。
- MQTT transport 新增 broker URI 和 device id 输入。
- Electron 主进程按 transport 选择 `ble_audio_stream.py` 或 `mqtt_audio_stream.py`。
- `npm run build` 和 `apps/desktop-electron npm run build` 均通过。

### 2026-06-25 23:xx MQTT pacing / docs

- MQTT sender 新增 `--max-send-bps`，默认 `32000`，按 16 kHz mono s16le 播放消费速率节流。
- MQTT sender 新增 `--startup-burst-bytes`，默认 `49152`，启动时先填一段 ring buffer，随后按 wall-clock pacing 发送。
- MQTT sender 默认 `--safety-margin=24576`。
- ACK/status 滑动窗口仍然保留：`effective_free = free - (sent - received)`。
- START 后必须等待 ESP32 status ACK，避免 ESP32 未订阅/未接收时盲发 DATA。
- sender 会在 `drainComplete=false`、`finalReceived != bytes` 或 `finalRead != bytes` 时失败退出，不再输出假阳性。
- 新增对接文档：`docs/WIFI_MQTT_TO_ESP32.zh.md`。
- 烧录当前 ESP32 固件后，WiFi/MQTT 3 秒 watermark 小样通过：
  - `bytes=96000`
  - `packets=534`
  - `finalFill=0`
  - `finalReceived=96000`
  - `finalRead=96000`
  - `drainComplete=true`

### 2026-06-26 00:xx WiFi full tests

- 历史记录：曾在 ESP32 侧 WiFi 音频 active 期间暂停 IMU I2C 采样，也曾对 V1 FT3168 probe 失败做过不启动轮询的 workaround。
- 当前 V2 规则：tools 不依赖这些 workaround；ESP32 V2 固件的显示/触摸/IMU 只在硬件层适配 CO5300/CST816/QMI8658，gateway/协议/tools 层不改触摸和 IMU 行为。
- WiFi/MQTT 完整 `03.mp3` watermark 通过：
  - metrics：`experiments/audio-flow/03-mqtt-watermark-paced-full6.csv`
  - summary：`experiments/audio-flow/03-mqtt-watermark-paced-full6.json`
  - `bytes=8387334`
  - `packets=46597`
  - `durationSeconds=263.3834548750019`
  - `averageBytesPerSecond=31844.57430699476`
  - `statusUpdates=2051`
  - `finalFree=131072`
  - `finalFill=0`
  - `finalReceived=8387334`
  - `finalRead=8387334`
  - `highWater=88228`
  - `drainComplete=true`
- WiFi/MQTT 完整 `03.mp3` PI 通过：
  - metrics：`experiments/audio-flow/03-mqtt-pi-paced-full.csv`
  - summary：`experiments/audio-flow/03-mqtt-pi-paced-full.json`
  - `bytes=8387334`
  - `packets=46597`
  - `durationSeconds=263.55114474499715`
  - `averageBytesPerSecond=31824.31253757327`
  - `statusUpdates=2051`
  - `finalFree=131072`
  - `finalFill=0`
  - `finalReceived=8387334`
  - `finalRead=8387334`
  - `highWater=66780`
  - `drainComplete=true`

### 2026-07-04 V2 BLE + WiFi/MQTT sender backpressure

- tools 版本：`1.4.2-v2`。
- 配套 ESP32 固件版本：`1.4.2-v2`。
- BLE sender 补齐与 MQTT sender 相同的 START ACK 等待和 END drain 等待。
- BLE/MQTT sender 都从 ESP32 status ACK 读取 `free/fill/received/read/high_water/active/finished`，再决定 DATA 发送节奏。
- GUI 的 BLE / WiFi MQTT transport 选择保留；选择哪个 transport，就由对应 sender 走同一套背压语义。

### 2026-07-05 V2 audio directory batch sender

- 新增 `scripts/audio_batch_stream.py`，先用 `ffprobe` 扫描音频文件/目录，再为每个文件构建 `ffmpeg -> s16le mono 16 kHz -> ACK backpressure sender` 路线。
- 新增 `npm run audio:batch`。
- Electron GUI 新增“选择目录”，可把目录内音频作为队列顺序发送。
- Electron GUI 的 transport 选择继续支持 BLE / WiFi MQTT；单文件走原 sender，多个文件走 batch sender。
- 本机目录 `/run/media/howtion/thinkplus/1.8/测试音频` 当前 4 个 WAV 已全量测试：
  - MQTT manifest：`experiments/audio-flow/v1.4.2-v2/batch-mqtt-wavs.json`
  - BLE manifest：`experiments/audio-flow/v1.4.2-v2/batch-ble-wavs.json`
  - 两个 manifest 均为 `ok=true`，`files=4`，`results=4`，所有结果 `drainComplete=true`。
