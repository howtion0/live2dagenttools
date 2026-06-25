# live2dagenttools

Live2D Agent 的跨平台交互工具集。目标是把“控制 ESP32 Live2D 设备”的业务逻辑写成可复用 TypeScript 内核，再按平台替换 transport：

- Android APK: Capacitor + Android SDK + BLE 插件/原生插件
- Desktop: Electron 或 Tauri + BlueZ/Web Bluetooth/平台桥接
- Web/PWA: Web Bluetooth 能力可用时直接调试
- Linux CLI: BlueZ D-Bus 调试 ESP32 BLE

## Architecture

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
