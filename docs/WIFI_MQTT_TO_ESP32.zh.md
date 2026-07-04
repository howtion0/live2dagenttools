# WiFi MQTT 发送到 ESP32 对接文档

本文档描述 `live2dagenttools` 通过 WiFi/MQTT 向 `live2desp32agent` 发送音频流的协议、流程和测试方法。

## 角色

```text
PC / Electron / CLI
  ffmpeg 解码 MP3/WAV/FLAC/... -> 16 kHz mono s16le PCM
  按 DATA 包切片
  publish 到 MQTT broker
  subscribe ESP32 ACK/status

MQTT broker
  只转发消息，不理解音频协议

ESP32
  gateway_wifi 订阅 audio/in
  remote_gateway 解析 START/DATA/END/CANCEL
  remote_dispatch 写入音频 ring buffer
  I2S/DMA audio task 消费播放
  publish audio/status 回传水位
```

## 默认配置

测试网络：

```text
WiFi SSID: FMai
WiFi Password: 147258147258
MQTT broker: mqtt://192.168.167.73:1883
Device ID: live2d-atri
```

ESP32 固件通过 Kconfig / sdkconfig 配置：

```text
CONFIG_LIVE2D_WIFI_ENABLED=y
CONFIG_LIVE2D_WIFI_SSID="FMai"
CONFIG_LIVE2D_WIFI_PASSWORD="147258147258"
CONFIG_LIVE2D_MQTT_BROKER_URI="mqtt://192.168.167.73:1883"
CONFIG_LIVE2D_MQTT_DEVICE_ID="live2d-atri"
```

## MQTT Topic

所有 topic 都带 `{device}`，默认是 `live2d-atri`。

```text
live2d/{device}/audio/in      PC -> ESP32，二进制音频包
live2d/{device}/audio/status  ESP32 -> PC，二进制 ACK/status
live2d/{device}/cmd           PC -> ESP32，文本控制命令
live2d/{device}/state         ESP32 -> PC，状态 JSON
```

当前音频发送使用 MQTT 3.1.1 TCP QoS 0。原因是音频有自己的序号、ACK、水位和重传外的实时策略，MQTT QoS 1/2 的确认语义会增加延迟和队列堆积。

## 音频包格式

MQTT `audio/in` payload 与 BLE 音频 characteristic 的 payload 完全一致。

多字节字段全部是 little-endian。

### START

```text
offset  size  meaning
0       u8    0x01
1       u32   total_hint，目前可填 0
5       u16   sample_rate，目前 16000
7       u8    channels，目前 1
8       u8    format，目前 1 = s16le mono
```

### DATA

```text
offset  size  meaning
0       u8    0x02
1       u16   seq，发送端递增，溢出后回绕
3       n     PCM payload，默认 180 bytes
```

PCM payload 是 `ffmpeg` 输出的 `s16le` 单声道数据。

### END

```text
offset  size  meaning
0       u8    0x03
```

### CANCEL

```text
offset  size  meaning
0       u8    0x04
```

## ACK/status 包格式

ESP32 publish 到 `audio/status`，payload 与 BLE status notify 一致。

```text
offset  size  meaning
0       u8    0x10
1       u32   free，ESP32 ring buffer 剩余字节
5       u32   fill，ESP32 ring buffer 已占用字节
9       u32   received，ESP32 已接收 PCM 字节数
13      u32   read，ESP32 播放任务已读取 PCM 字节数
17      u32   high_water，本次会话最高水位
21      u8    active，1=会话仍活跃
22      u8    finished，1=已收到 END
```

发送端用 `received` 计算 outstanding：

```text
outstanding = sent - received
effective_free = free - outstanding
```

只有 `effective_free >= payload_len + safety_margin` 时才继续发 DATA。

## 流控模型

当前模型是：

```text
producer-consumer + ACK credit sliding window + ring-buffer watermark + send-rate pacing
```

含义：

- `ffmpeg` 是生产者，持续生产 PCM。
- MQTT 发送器是第一层消费者，把 PCM 切成 DATA 包。
- ESP32 ring buffer 是第二层生产消费边界。
- ESP32 I2S/DMA 播放任务是最终消费者。
- ACK/status 回传 `free/fill/received/read`，让 PC 端知道 ESP32 实际水位。
- watermark 模式按剩余空间放行。
- PI 模式按目标水位计算每 tick 可发送预算。
- `--max-send-bps` 是额外限速，避免 MQTT callback/队列入口被瞬间打满。

默认限速：

```text
PCM: 16000 samples/s * 2 bytes = 32000 bytes/s
--max-send-bps 32000
--startup-burst-bytes 49152
--safety-margin 24576
```

启动阶段允许先填一段缓冲，之后按真实播放速度附近发送。

发送端在 publish START 后必须等到 ESP32 从 `audio/status` 回一帧 ACK/status，再开始发送 DATA。这样可以避免 ESP32 尚未订阅或 MQTT 会话断开时，PC 端把 DATA 盲发进 broker。

## CLI 使用

启动 broker：

```bash
mosquitto -c /tmp/live2d-mosquitto.conf -v
```

3 秒小样 watermark：

```bash
npm run audio:mqtt -- \
  --broker mqtt://192.168.167.73:1883 \
  --device-id live2d-atri \
  --input /tmp/live2d_03_first3s.mp3 \
  --mode watermark \
  --metrics experiments/audio-flow/smoke-mqtt-watermark-paced.csv \
  --summary experiments/audio-flow/smoke-mqtt-watermark-paced.json
```

3 秒小样 PI：

```bash
npm run audio:mqtt -- \
  --broker mqtt://192.168.167.73:1883 \
  --device-id live2d-atri \
  --input /tmp/live2d_03_first3s.mp3 \
  --mode pi \
  --metrics experiments/audio-flow/smoke-mqtt-pi-paced.csv \
  --summary experiments/audio-flow/smoke-mqtt-pi-paced.json
```

完整音频：

```bash
npm run audio:mqtt -- \
  --broker mqtt://192.168.167.73:1883 \
  --device-id live2d-atri \
  --input /run/media/howtion/thinkplus/1.8/03.mp3 \
  --mode watermark \
  --metrics experiments/audio-flow/03-mqtt-watermark-paced.csv \
  --summary experiments/audio-flow/03-mqtt-watermark-paced.json
```

可调参数：

```text
--chunk-size 180
--safety-margin 24576
--target-fill 65536
--max-send-bps 32000
--startup-burst-bytes 49152
--tick-ms 20
--start-ack-timeout 10
--drain-timeout 20
```

## Electron GUI 流程

1. 选择音频文件。
2. GUI 用 `ffprobe` 自动检测格式、时长、码率、采样率、声道和媒体尺寸。
3. Transport 选择 `WiFi / MQTT`。
4. 填 broker，例如 `mqtt://192.168.167.73:1883`。
5. 填 device id，例如 `live2d-atri`。
6. 选择 `watermark` 或 `pi`。
7. 点击开始。
8. GUI 实时显示 produce/send/status/wait/pace_wait/end。

## ESP32 接收流程

```text
gateway_wifi
  MQTT_EVENT_DATA(audio/in)
  -> audio queue
  -> remote_gateway_audio_packet(REMOTE_GATEWAY_SOURCE_MQTT, payload)

remote_gateway
  START: 申请 owner=mqtt，调用 remote_dispatch_audio_stream_start()
  DATA: 校验会话后调用 remote_dispatch_audio_stream_write()
  END: 调用 remote_dispatch_audio_stream_finish()
  CANCEL: 调用 remote_dispatch_audio_stream_cancel()

remote_dispatch
  写 ring buffer
  维护 free/fill/received/read/high_water
  status callback

gateway_wifi
  status callback -> status queue -> MQTT publish audio/status
```

当前 V2 固件不再通过通信层暂停 IMU 或改变触摸轮询来规避问题。显示、触摸、IMU 适配限制在 ESP32 板级硬件层：V2 使用 CO5300 + CST816 + QMI8658。V1 的 SH8601 + FT3168 记录保留，但不是当前出货硬件目标。

## BLE / WiFi 互斥

ESP32 端 `remote_gateway` 维护当前 owner。

```text
owner = none:
  BLE START 或 MQTT START 都可以开始

owner = ble:
  BLE DATA/END/CANCEL 允许
  MQTT START/DATA 拒绝

owner = mqtt:
  MQTT DATA/END/CANCEL 允许
  BLE START/DATA 拒绝
```

会话结束并播放 drain 完成后释放 owner。

当前 V2 构建里 BLE gateway 和 WiFi/MQTT gateway 都会初始化。ESP32 端 `remote_gateway` 维护音频 owner；发送端必须先等 START status ACK，再按 ACK/status 背压发 DATA，END 后等待 drain ACK。

## 通过标准

发送端 summary 需要满足：

```text
ok = true
finalFill = 0
finalReceived = bytes
finalRead = bytes
drainComplete = true
```

发送端如果没有收到 START ACK、MQTT reader 断开、drain 超时、`finalReceived != bytes` 或 `finalRead != bytes`，命令必须非零退出。

ESP32 串口应看到：

```text
wifi connected ssid=FMai ip=...
mqtt connected broker=...
mqtt subscribed topic=live2d/live2d-atri/audio/in
audio stream start source=mqtt
audio stream finish/end
```

如果出现 2-3 秒卡住，优先看：

- `--max-send-bps` 是否被关闭或设置过大。
- `fill/high_water` 是否快速顶满。
- `received` 是否停止增长。
- ESP32 串口是否出现 WDT、MQTT disconnect 或 audio queue full。
