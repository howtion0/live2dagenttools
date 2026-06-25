# Live2D ESP32 BLE 音频流协议

版本：`1.0 / 1.0-pid`

## 链路

```text
本机 ffmpeg 流式生产 PCM
  -> PC sender 消费 ffmpeg stdout
  -> watermark ACK 或 PC-side PI 控制 BLE 发送
  -> ESP32 BLE 接收
  -> CPU0 remote_wireless 解析 START/DATA/END/CANCEL
  -> CPU0 remote_dispatch 写 remote audio ring
  -> ESP32 notify ACK/status
  -> CPU0 audio task 从 ring 消费
  -> mono s16le 转 stereo s16le
  -> I2S DMA / ES8311 / speaker
```

## GATT

```text
device name: Live2D-ATRI
service:     01104c21-e36a-2f97-454c-5a8a2f8f369e
command:     02104c21-e36a-2f97-454c-5a8a2f8f369e
audio write: 03104c21-e36a-2f97-454c-5a8a2f8f369e
status ACK:  04104c21-e36a-2f97-454c-5a8a2f8f369e
```

## 音频格式

```text
16 kHz mono s16le PCM
DATA payload: 180 bytes
remote audio ring: 128 KiB
playback low watermark: 64 KiB
```

## 写入包

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

## ACK/status 包

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

`received` 是 ACK，表示 ESP32 已经真正写入 ring 的 PCM 字节数。`fill` 是控制目标，表示当前 ring 水位。

## Watermark 1.0

```text
outstanding = max(0, sent - received)
effective_free = max(0, free - outstanding)

if effective_free >= payload_len + 4096:
  send DATA
else:
  wait
```

## PI 1.0-pid

PI 在电脑端运行，ESP32 协议不变。PI 调发送预算，不调 BLE 单包大小。

```text
target_fill = 96 KiB
error = target_fill - fill
integral += error * dt
budget = base_budget + Kp * error + Ki * integral
```

当前参数：

```text
tick = 20 ms
Kp = 0.006
Ki = 0.00004
max_budget = 2200 bytes/tick
payload = 180 bytes
```

PI 仍保留 watermark 硬保护，防止 ring full。

## 03.mp3 实测

```text
watermark: 8387334 bytes / 46597 packets / 260.46 s
pi:        8387334 bytes / 46597 packets / 260.69 s
```

对比图：

```text
experiments/audio-flow/03-watermark-vs-pi.svg
```

