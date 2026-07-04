# live2dagenttools

Version: `1.4.1-v2`

Live2D Agent 的跨平台交互工具集。目标是把“控制 ESP32 Live2D 设备”的业务逻辑写成可复用 TypeScript 内核，再按平台替换 transport：

- Android APK: Capacitor + Android SDK + BLE 插件/原生插件
- Desktop: Electron 或 Tauri + BlueZ/Web Bluetooth/平台桥接
- Web/PWA: Web Bluetooth 能力可用时直接调试
- Linux CLI: BlueZ D-Bus 调试 ESP32 BLE

当前配套固件目标是 Waveshare ESP32-S3-Touch-AMOLED-1.8 V2；GitHub tag/release 使用 V2 后缀。V1 硬件记录保留在 ESP32 仓库文档中。

## Architecture

详细接力说明见 [docs/HANDOFF.zh.md](docs/HANDOFF.zh.md)。

```text
apps/
  cli/                 Linux/开发机命令行调试入口
  web/                 Web/PWA UI 壳
  android/             Capacitor Android 壳
  desktop-electron/    Electron 桌面壳

packages/
  protocol/            命令定义、编码、解析
  interaction-core/    设备连接、命令队列、业务动作
  transport-mock/      UI/测试用 mock transport
  transport-bluez/     Linux BlueZ BLE transport
```

依赖方向固定为：

```text
UI/App -> interaction-core -> protocol
UI/App -> platform transport -> transport interface
transport -> platform API
```

核心代码不要直接依赖 Capacitor、Electron、BlueZ 或 Android SDK。

### Why `cli` and `web` Are Separate

`apps/cli` 不是一个平台产品壳，它是开发工具入口：适合在电脑上用命令行快速发 BLE 命令、验证 ESP32 协议、做自动化测试。

`apps/web` 是图形界面入口：未来可以被浏览器/PWA 使用，也可以作为 Capacitor Android 和 Electron 桌面壳里的共享 UI。

所以目录不是这样分：

```text
cli/android
cli/electron
```

而是这样分：

```text
apps/cli               开发机命令行
apps/web               共享图形 UI
apps/android           Android 原生壳，承载 web UI
apps/desktop-electron  桌面原生壳，承载 web UI
```

真正按平台变化的是 transport：

```text
transport-bluez             Linux 电脑蓝牙
transport-capacitor-ble     Android 蓝牙，后续添加
transport-electron-ble      桌面蓝牙，后续添加
transport-web-bluetooth     浏览器蓝牙，后续添加
```

## Requirements

- Node.js 20+
- npm 10+
- Linux BLE 调试：BlueZ / bluetoothctl / python3-dbus
- Android 构建：Android Studio + Android SDK + JDK
- Desktop 构建：Electron 依赖按平台安装

## Install

```bash
npm install --no-bin-links
```

这个仓库当前放在移动盘上，文件系统不支持 symlink；所以安装时使用 `--no-bin-links`。如果后面移动到 ext4/APFS/NTFS 等支持 symlink 的目录，可以直接用 `npm install`。

## Build

```bash
npm run build
```

默认 build 只覆盖共享 TypeScript 内核、Linux CLI transport 和 Web 壳，不拉 Electron/Android 大依赖。

只检查 TypeScript：

```bash
npm run typecheck
```

## Linux BLE CLI

先确认 ESP32 固件已经广播 `esplive2d`，并知道设备 MAC，例如：

```text
3C:DC:75:6F:C2:72
```

发送命令：

```bash
npm run cli -- send --device 3C:DC:75:6F:C2:72 --message ping
npm run cli -- send --device 3C:DC:75:6F:C2:72 --message wave
npm run cli -- send --device 3C:DC:75:6F:C2:72 --message speak:ATR_b102_015
```

BlueZ transport 默认写入 ESP32 当前固件的 characteristic：

```text
service:        01104c21-e36a-2f97-454c-5a8a2f8f369e
characteristic: 02104c21-e36a-2f97-454c-5a8a2f8f369e
```

## Android / Capacitor

Capacitor 不是 Android SDK 的替代品，它是 WebView + 原生插件桥。Android APK 仍然由 Android SDK/Gradle 构建。

Android 作为可选目标单独安装依赖。初始化 Android 工程：

```bash
npm run android:init
```

打开 Android Studio：

```bash
npm run android:open
```

后续 Android BLE transport 应放在单独包里，例如：

```text
packages/transport-capacitor-ble
```

这样 Android 只替换 transport，不改 `interaction-core`。

## Desktop / Electron

Electron 只作为桌面壳，不用于 Android。桌面端可以复用 UI、协议和 interaction core，但 BLE/系统能力必须走桌面 transport。

```bash
npm run desktop:dev
```

桌面端 `1.1` 已加入 wired-elements 风格 GUI：

- 选择本机音频文件。
- ffprobe 自动检测格式、时长、码率、采样率、通道和画面尺寸。
- 扫描/选择蓝牙设备。
- 选择 watermark 压降法或 PI 控制法。
- 启动后实时显示 ffmpeg 生产数据、发送数据、ACK/status、buffer fill/free 和日志。

桌面端依赖 Electron，默认不参与根构建，避免基础协议/CLI 开发时被大包下载拖慢。

## Development Rules

- `packages/protocol` 只定义命令和字节编码，不依赖平台。
- `packages/interaction-core` 只依赖 transport interface，不知道 BLE/USB/WiFi 细节。
- 每个平台新增一个 transport 包，不把平台 API 写进 core。
- ESP32 端协议解析应与 `packages/protocol` 保持同名命令。

## Current ESP32 Protocol Draft

当前固件先支持文本命令写入 BLE characteristic：

```text
ping
wave
speak:<clip_id>
motion:<motion_id>
```

后面如果命令变复杂，可以把 `protocol` 从纯文本升级为 JSON Lines 或二进制帧，但 transport interface 不需要变化。

## BLE MP3 Streaming 1.0 / 1.0-pid

当前仓库支持把本机 MP3 流式送到 ESP32：

```text
本机 ffmpeg
  -> 实时解码 MP3 为 16 kHz mono s16le PCM
  -> PC 端 sender 消费 ffmpeg stdout
  -> sender 按 ACK 水位版或 PI 版控制 BLE 发送
  -> ESP32 BLE 接收 DATA
  -> ESP32 CPU0 解析协议并写入 remote audio ring
  -> ESP32 回传 ACK/status
  -> ESP32 CPU0 音频任务从 ring 读 PCM
  -> mono s16le 转 stereo s16le
  -> I2S DMA / ES8311 / speaker
```

发送脚本：

```bash
npm run audio:send -- \
  --device 3C:DC:75:6F:C2:72 \
  --input /run/media/howtion/thinkplus/1.8/03.mp3 \
  --mode watermark \
  --metrics experiments/audio-flow/03-watermark.csv \
  --summary experiments/audio-flow/03-watermark.json

npm run audio:send -- \
  --device 3C:DC:75:6F:C2:72 \
  --input /run/media/howtion/thinkplus/1.8/03.mp3 \
  --mode pi \
  --metrics experiments/audio-flow/03-pi.csv \
  --summary experiments/audio-flow/03-pi.json
```

绘图：

```bash
npm run audio:plot -- \
  --watermark experiments/audio-flow/03-watermark.csv \
  --pi experiments/audio-flow/03-pi.csv \
  --out experiments/audio-flow/03-watermark-vs-pi.svg \
  --summary experiments/audio-flow/03-comparison.json
```

水位版是 `1.0` 基线：

```text
outstanding = max(0, sent - received)
effective_free = max(0, free - outstanding)

if effective_free >= payload_len + 4096:
  send DATA
else:
  wait
```

PI 版是 `1.0-pid`，PID/PI 只在电脑端运行，ESP32 协议不变。它保留水位硬保护，同时用 `target_fill - fill` 控制每个 tick 的发送预算：

```text
target_fill = 96 KiB
error = target_fill - fill
integral += error * dt
budget = base_budget + Kp * error + Ki * integral
```

当前默认参数：

```text
tick = 20 ms
Kp = 0.006
Ki = 0.00004
min_budget = 0 bytes/tick
max_budget = 2200 bytes/tick
payload = 180 bytes
```

PI 输出控制的是 `send_budget_per_tick`，不是 BLE 单包大小。单包 payload 保持 180 bytes，避免和 ATT MTU、BlueZ、NimBLE 行为互相干扰。

### 03.mp3 对比结果

测试文件：

```text
/run/media/howtion/thinkplus/1.8/03.mp3
```

结果文件：

```text
experiments/audio-flow/03-watermark.csv
experiments/audio-flow/03-watermark.json
experiments/audio-flow/03-pi.csv
experiments/audio-flow/03-pi.json
experiments/audio-flow/03-comparison.json
experiments/audio-flow/03-watermark-vs-pi.svg
```

实测结果：

| 模式 | PCM bytes | packets | duration | avg throughput | avg fill | max fill |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| watermark | 8,387,334 | 46,597 | 260.46 s | 32,201 B/s | 121,145 B | 122,880 B |
| pi | 8,387,334 | 46,597 | 260.69 s | 32,174 B/s | 98,820 B | 101,212 B |

结论：

- 两种模式吞吐几乎一样，都贴近 16 kHz mono s16le 的播放速率。
- 水位版平均 fill 更高，基本维持在 120 KiB 以上，延迟更高。
- PI 版把平均 fill 压到约 96-100 KiB，峰值也低很多，播放安全余量仍足够。
- 现阶段 PI 的价值主要是降低平均缓存和延迟，不是提升吞吐。

协议细节见工作区根目录：

```text
/run/media/howtion/thinkplus/1.8/LIVE2D_ESP32_STREAM_PROTOCOL.zh.md
```

## WiFi/MQTT Streaming 1.4-v2

tools 已新增 MQTT 音频发送脚本，协议包格式和 ACK/status 与 BLE 完全一致。BLE 和 MQTT sender 都必须先等 ESP32 START status ACK，再按 `free/fill/received/read` 背压发 DATA，END 后等待 drain ACK。MQTT 只是替换 transport：

```text
本机 ffmpeg
  -> 实时解码 MP3 为 16 kHz mono s16le PCM
  -> PC sender 按 watermark 或 PI 控制发送
  -> MQTT publish live2d/{device}/audio/in
  -> ESP32 MQTT gateway 写入 remote audio ring
  -> ESP32 publish live2d/{device}/audio/status
```

发送脚本：

```bash
npm run audio:mqtt -- \
  --broker mqtt://192.168.1.10:1883 \
  --device-id live2d-atri \
  --input /run/media/howtion/thinkplus/1.8/03.mp3 \
  --mode watermark \
  --metrics experiments/audio-flow/03-mqtt-watermark.csv \
  --summary experiments/audio-flow/03-mqtt-watermark.json \
  --progress-json

npm run audio:mqtt -- \
  --broker mqtt://192.168.1.10:1883 \
  --device-id live2d-atri \
  --input /run/media/howtion/thinkplus/1.8/03.mp3 \
  --mode pi \
  --metrics experiments/audio-flow/03-mqtt-pi.csv \
  --summary experiments/audio-flow/03-mqtt-pi.json \
  --progress-json
```

Topic：

```text
live2d/{device}/cmd
live2d/{device}/audio/in
live2d/{device}/audio/status
live2d/{device}/state
```

施工文档见：

```text
docs/WIFI_MQTT_GATEWAY_CONSTRUCTION.zh.md
docs/WIFI_MQTT_TO_ESP32.zh.md
```

默认发送节流：

```text
--max-send-bps 32000
--startup-burst-bytes 49152
```

`--max-send-bps` 按 16 kHz mono s16le 的播放消费速度限速，ACK/status 仍然负责 ring buffer 水位和滑动窗口。
