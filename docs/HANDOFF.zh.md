# Live2D Agent Tools 接力文档

日期：2026-06-25

相关仓库：

```text
ESP32 固件:
  path: /run/media/howtion/thinkplus/1.8/live2desp32agent
  remote: git@github.com:howtion0/live2desp32agent.git

跨平台交互工具:
  path: /run/media/howtion/thinkplus/1.8/live2dagenttools
  remote: git@github.com:howtion0/live2dagenttools.git
  current commit: c24b0b1 Scaffold cross-platform Live2D agent tools
```

## 总目标

做一个可复用的 Live2D Agent 控制体系：

```text
手机/电脑 UI
  -> TypeScript interaction core
  -> 平台 transport
  -> BLE / WiFi / USB / WebSocket
  -> ESP32 command/audio protocol
  -> Live2D 动作、表情、语音、后续实时音频流
```

核心原则：

- UI 可以换，交互内核不换。
- Android、Electron、Web、CLI 只换 transport。
- ESP32 上 BLE、WiFi、USB 串口未来共用同一套协议解析和命令分发。
- 音频流不要塞进当前 BLE 文本命令 characteristic；BLE 适合控制命令，WiFi 更适合连续音频。

## 当前已完成状态

### ESP32 固件状态

当前固件仓库已经有无线组件：

```text
components/remote_wireless/
  remote_wireless.c
  remote_wireless.h
```

它已经接入主程序：

```text
main/CMakeLists.txt -> REQUIRES remote_wireless
main/main.c         -> app_main() 调 remote_wireless_init()
sdkconfig.defaults  -> 打开 BT/NimBLE 配置
```

当前无线功能：

```text
WiFi STA:
  ssid: FMai
  password: 147258147258
  status: 会尝试连接，但当前实测失败 reason=201

BLE:
  name: esplive2d
  role: peripheral
  GATT: 一个自定义 service + 一个可写 command characteristic
  status: 已修复广播，电脑可扫描、连接、写入 ping
```

### ESP32 BLE UUID

固件中 UUID 是按 NimBLE little-endian 初始化写的。外部工具看到的是：

```text
BLE device name:
  esplive2d

Service UUID:
  01104c21-e36a-2f97-454c-5a8a2f8f369e

Command Characteristic UUID:
  02104c21-e36a-2f97-454c-5a8a2f8f369e

Characteristic flags:
  write
  write-without-response

MTU:
  observed 247
```

当前 command characteristic 收到数据后只打日志：

```c
ESP_LOGI(TAG, "ble cmd len=%u value=\"%s\"", (unsigned int)len, command);
```

下一步要把这里接到 ESP32 端协议解析和 command dispatch。

### BLE 广播问题已修复

一开始 BLE 广播失败：

```text
ble adv fields failed rc=4
```

原因：advertising payload 里同时塞完整设备名和 128-bit service UUID，超过 legacy advertising 31 字节限制。

已修复为：

```text
advertising payload:
  flags
  complete local name: esplive2d

scan response:
  128-bit service UUID
```

修复后启动日志确认：

```text
remote_wireless: ble advertising name=esplive2d
```

### 本机蓝牙调试已验证

本机 BlueZ 状态：

```text
bluetoothctl: 5.84
hci0: available
```

曾经服务是 inactive，适配器 DOWN：

```text
systemctl is-active bluetooth -> inactive
hciconfig hci0 -> DOWN
```

启动后：

```text
systemctl start bluetooth
hciconfig hci0 -> UP RUNNING
```

扫描结果：

```text
[NEW] Device 3C:DC:75:6F:C2:72 esplive2d
```

连接结果：

```text
Connection successful
ServicesResolved: yes
```

BlueZ 解析到：

```text
Primary Service:
  01104c21-e36a-2f97-454c-5a8a2f8f369e

Characteristic:
  02104c21-e36a-2f97-454c-5a8a2f8f369e
  Flags: write-without-response
  Flags: write
  MTU: 0x00f7 (247)
```

`bluetoothctl` 的 `write` 命令实测会报：

```text
Failed to write: org.bluez.Error.NotSupported
```

但用 BlueZ D-Bus 的 `GattCharacteristic1.WriteValue(..., {"type": "command"})` 能成功写入：

```text
wrote ping
```

所以 tools 里先实现 `transport-bluez`，走 Python dbus 调 BlueZ D-Bus，而不是依赖 `bluetoothctl write`。

### live2dagenttools 当前结构

```text
apps/
  cli/                 电脑命令行调试入口
  web/                 未来共享图形 UI/PWA 入口
  android/             Capacitor Android 壳
  desktop-electron/    Electron 桌面壳

packages/
  protocol/            命令定义、编码、解析
  interaction-core/    连接、命令发送、业务动作
  transport-bluez/     Linux BlueZ BLE 写入
  transport-mock/      UI/测试 mock
```

现在没有用 npm workspaces，因为当前移动盘文件系统不支持 symlink。安装方式：

```bash
npm install --no-bin-links
```

默认构建：

```bash
npm run build
npm run typecheck
```

已验证通过。

## apps/cli 和 apps/web 的分工

`apps/cli` 是开发机调试工具，不是产品 UI，不再细分 Android/Electron。

用途：

```text
快速验证 ESP32 是否可连接
快速发 ping/wave/speak
做自动化协议测试
排查 BLE/WiFi/音频流问题
```

`apps/web` 是图形界面入口，未来可以被多个壳复用：

```text
浏览器/PWA
Capacitor Android WebView
Electron BrowserWindow
```

平台差异应该放在 transport：

```text
transport-bluez             Linux 本机 BLE
transport-capacitor-ble     Android BLE，待实现
transport-electron-ble      桌面 BLE，待实现
transport-web-bluetooth     浏览器 Web Bluetooth，待实现
transport-wifi              WiFi/WebSocket/UDP，待实现
transport-serial            USB 串口，待实现
```

不要做：

```text
apps/cli/android
apps/cli/electron
```

应该做：

```text
apps/android           Android 产品壳
apps/desktop-electron  桌面产品壳
apps/web               共享 UI
packages/*             共享业务和协议
```

## 当前命令协议草案

现在先用 UTF-8 文本命令，简单、便于 nRF Connect/BlueZ/串口调试：

```text
ping
wave
speak:<clip_id>
motion:<motion_id>
```

建议逐步扩展，不要一开始上复杂二进制协议。

推荐下一步格式：

```text
ping
wave
speak:ATR_b102_015
motion:idle
face:happy
look:0.20,-0.10
audio:start:<stream_id>:<sample_rate>:<channels>:<format>
audio:stop:<stream_id>
```

如果后续需要严格校验、ACK、分片、重传，再升级到 JSON Lines：

```json
{"t":"ping","id":1}
{"t":"wave","id":2}
{"t":"speak","id":3,"clip":"ATR_b102_015"}
{"t":"audio_start","id":4,"stream":"mic1","rate":16000,"channels":1,"format":"s16le"}
```

或者二进制帧：

```text
magic: 2 bytes
version: 1 byte
type: 1 byte
seq: 2 bytes
len: 2 bytes
payload: len bytes
crc16: 2 bytes
```

但二进制帧应等文本协议跑通后再做。

## ESP32 端下一步结构

当前 `remote_wireless.c` 直接在 BLE callback 里打日志。下一步建议拆：

```text
components/
  remote_protocol/
    remote_protocol.h
    remote_protocol.c

  remote_dispatch/
    remote_dispatch.h
    remote_dispatch.c

  remote_wireless/
    remote_wireless.c
    remote_wireless.h
```

职责：

```text
remote_wireless:
  BLE/WiFi 接收字节
  不理解 Live2D 业务

remote_protocol:
  解析文本命令或帧
  输出结构化 remote_cmd_t

remote_dispatch:
  把 remote_cmd_t 投递到正确任务
  不在 BLE callback 里直接操作 Live2D model
```

建议 C 接口：

```c
typedef enum {
    REMOTE_CMD_PING,
    REMOTE_CMD_WAVE,
    REMOTE_CMD_SPEAK,
    REMOTE_CMD_MOTION,
    REMOTE_CMD_AUDIO_START,
    REMOTE_CMD_AUDIO_STOP,
    REMOTE_CMD_UNKNOWN,
} remote_cmd_type_t;

typedef struct {
    remote_cmd_type_t type;
    char arg0[48];
    char arg1[48];
} remote_cmd_t;

bool remote_protocol_parse_text(const char* input, size_t len, remote_cmd_t* out);
esp_err_t remote_dispatch_command(const remote_cmd_t* cmd);
```

Live2D 动作要投递给渲染任务处理：

```text
BLE callback
  -> parse command
  -> xQueueSend(remote_cmd_queue)
  -> render/update task 取命令
  -> 改 Live2D 参数/动作状态
```

不要在 NimBLE host task callback 里直接做耗时工作，也不要直接写 model。

## WiFi 当前状态和判断

当前固件配置：

```text
SSID: FMai
PASS: 147258147258
auth threshold: WPA2_PSK
SAE PWE: WPA3_SAE_PWE_BOTH
```

实测日志：

```text
remote_wireless: wifi sta start, connecting to FMai
wifi:Coexist: Wi-Fi connect fail, apply reconnect coex policy
remote_wireless: wifi disconnected reason=201, reconnecting
```

`reason=201` 通常表示没有找到目标 AP 或扫描/认证阶段没有可用目标。优先排查：

```text
1. FMai 是否是 2.4GHz 热点
2. 手机热点是否只开了 5GHz
3. SSID 是否完全一致，大小写是否一致
4. 热点是否隐藏 SSID
5. ESP32 和热点距离/信号
6. 热点认证是否 WPA2/WPA3 混合导致兼容问题
7. 热点是否限制设备数量或拉黑 MAC
```

ESP32-S3 只支持 2.4GHz WiFi，不支持 5GHz。

建议下一步：

```text
先用手机开 2.4GHz 兼容模式热点
SSID 改成简单 ASCII，例如 Live2DTest
密码先用 8-16 位简单 WPA2
确认 ESP32 日志出现 got ip
```

如果仍然失败，在 ESP32 上加 WiFi scan，把附近 SSID 打出来，确认是否能扫到 `FMai`。

## BLE 与 WiFi 的职责划分

建议职责：

```text
BLE:
  设备发现
  连接配对/授权
  小命令
  WiFi 配网
  短文本状态

WiFi:
  高频状态
  音频流
  大文件/资源传输
  WebSocket/UDP 实时交互
```

原因：

```text
BLE 优点:
  发现方便
  手机权限模型清晰
  低功耗
  小命令可靠

BLE 缺点:
  吞吐有限
  分片麻烦
  长时间音频流容易受连接参数、手机系统调度影响

WiFi 优点:
  吞吐足够
  TCP/WebSocket/UDP 容易做流
  更适合音频

WiFi 缺点:
  需要配网
  内存占用高
  ESP32 当前 SRAM 已经变紧
```

## 音频现状

ESP32 固件已有 flash 内置语音播放：

```text
flash raw PCM
  -> audio task on CPU0
  -> i2s_channel_write()
  -> I2S DMA
  -> ES8311
  -> speaker
```

当前内置语音资产格式：

```text
16 kHz
s16le
stereo
raw PCM
```

日志示例：

```text
audio_tone: init ES8311/I2S sample_rate=16000 heap_sram=55936 heap_psram=6746528
audio_tone: audio ready
openlive2d_atri: play voice clip ATR_b102_015 bytes=380160
audio_tone: play flash pcm bytes=380160
audio_tone: play done heap_sram=49796 heap_psram=6745992
```

打开 WiFi+BLE 后资源大致：

```text
SRAM free: about 49-56 KB
SRAM min: about 36-38 KB
largest SRAM block: about 18 KB
PSRAM free: about 6.745 MB
```

结论：

```text
大 buffer 必须放 PSRAM
DMA 直接用的 buffer 必须谨慎，I2S driver 内部 DMA 仍用内部 DMA SRAM
应用层音频 ring buffer 不要放内部 SRAM
```

## ESP32 传音频流：推荐路线

“传音频流”这里建议定义为：

```text
电脑/手机把一段实时或准实时 PCM/Opus 音频发给 ESP32
ESP32 接收、缓冲、解码或转换
通过 I2S/ES8311 播放
```

### 第一阶段：WiFi TCP/WebSocket + PCM

先做最简单可靠的：

```text
客户端:
  采集或读取音频
  转成 16kHz mono s16le
  通过 TCP/WebSocket 发送小块 PCM

ESP32:
  TCP/WebSocket server 或 client
  收到 PCM chunk
  写入 PSRAM ring buffer
  audio stream task 从 ring buffer 读
  mono -> stereo
  i2s_channel_write()
```

推荐音频格式：

```text
sample_rate: 16000
channels: 1
format: s16le
chunk duration: 20ms 或 40ms
```

码率：

```text
16k mono s16le:
  16000 samples/s * 2 bytes = 32000 bytes/s
  about 32 KB/s

20ms chunk:
  16000 * 0.02 * 2 = 640 bytes

40ms chunk:
  1280 bytes
```

ESP32 播放 stereo 时复制采样：

```text
mono sample M
  -> stereo L=M, R=M
```

应用层 ring buffer 建议：

```text
capacity: 64 KB 起步
location: PSRAM
low watermark: 8 KB
high watermark: 48 KB
```

播放策略：

```text
收到 audio:start 后先缓冲到 low watermark
达到 low watermark 再启动播放
buffer underflow 时写静音或暂停
audio:stop 清空 buffer 并停流
```

### 第二阶段：WiFi UDP + jitter buffer

如果 WebSocket/TCP 延迟不满意，再做 UDP：

```text
UDP packet:
  stream_id
  seq
  timestamp
  payload pcm
```

ESP32：

```text
按 seq 放入 jitter buffer
允许少量乱序
丢包时补静音
保持播放时钟稳定
```

UDP 更适合低延迟，但复杂度明显更高。第一版不建议直接 UDP。

### 第三阶段：压缩编码

如果 WiFi 稳定后想提升质量或降低带宽，可以考虑：

```text
Opus 16k mono
ADPCM
IMA ADPCM
```

注意：

```text
Opus 解码会占 CPU
当前 CPU1 Live2D 已经很忙
解码必须放 CPU0
需要实测是否影响 LCD/audio
```

当前扬声器音质一般，第一版 PCM 已经足够验证体验。

## BLE 传音频流是否可行

BLE 理论上可以传短音频，但不推荐作为主路线。

当前 BLE MTU 247，单包 payload 理论上约 244 bytes。音频需求：

```text
16k mono s16le: 32 KB/s
8k mono s16le: 16 KB/s
```

BLE 要稳定达到 32 KB/s，需要较好的连接参数、手机系统调度、write without response 连续写、ESP32 及时消费。实际很容易受到：

```text
连接间隔
手机 BLE 栈节流
NimBLE host task 调度
ESP32 SRAM 紧张
Live2D 渲染抢 CPU/PSRAM
```

BLE 可以先做一个小实验：

```text
8kHz mono s16le
20ms chunk = 320 bytes
每 chunk 分 2 个 BLE write
ESP32 收到后写 PSRAM ring buffer
播放端重复采样到 16kHz
```

但产品路线建议：

```text
BLE 负责控制和配网
WiFi 负责音频流
```

## 建议音频协议

控制通道仍走 BLE 或 WebSocket 文本命令：

```text
audio:start:<stream_id>:16000:1:s16le
audio:stop:<stream_id>
audio:clear
```

音频数据通道建议二进制帧：

```text
struct audio_frame_header {
    uint32_t magic;       // 'L2DA'
    uint8_t  version;     // 1
    uint8_t  type;        // 1=pcm, 2=control, 3=ack
    uint16_t header_len;
    uint32_t stream_id;
    uint32_t seq;
    uint32_t timestamp_ms;
    uint16_t sample_rate;
    uint8_t  channels;
    uint8_t  format;      // 1=s16le
    uint16_t payload_len;
    uint16_t crc16;
};
payload: PCM bytes
```

第一版可以更简单：

```text
WebSocket:
  text: audio:start:1:16000:1:s16le
  binary: raw PCM chunk
  text: audio:stop:1
```

只要一个连接上只有一个音频流，就不需要 header。

## ESP32 音频流任务建议

新增组件：

```text
components/remote_audio_stream/
  remote_audio_stream.h
  remote_audio_stream.c
```

职责：

```text
remote_audio_stream_start(config)
remote_audio_stream_write(chunk)
remote_audio_stream_stop()
remote_audio_stream_get_stats()
```

内部任务：

```text
audio_stream_rx:
  由 WiFi/BLE callback 调 write，不建议在 callback 里阻塞

audio_stream_play_task:
  pinned to CPU0
  从 PSRAM ring buffer 读 mono PCM
  转成小块 stereo PCM
  i2s_channel_write()
```

关键点：

```text
1. BLE/WiFi callback 不能直接 i2s_channel_write()
2. ring buffer 放 PSRAM
3. 转 stereo 的临时小 buffer 控制在 1-4 KB
4. underflow 写静音，避免喇叭爆音
5. stop 时淡出或至少清零
6. 播放和内置 flash voice 要互斥，不能两个任务同时写 I2S
```

需要和现有 `audio_tone` 统一：

```text
audio_tone 当前负责 flash voice
remote_audio_stream 未来负责流式 audio
最终应该有一个 audio_mixer/audio_output 层统一 I2S 写入
```

短期可先做互斥：

```text
stream active 时禁止 flash voice
flash voice 播放时拒绝 stream 或停止 voice
```

长期做 mixer：

```text
voice channel
stream channel
tone/effect channel
  -> simple mix/clamp
  -> I2S
```

但 mixer 会增加 CPU，先不要做复杂。

## 本机工具下一步

当前 `transport-bluez` 只能写已连接/已解析服务的 characteristic。下一步要补完整：

```text
scan()
connect()
resolve services
write command
disconnect
```

Linux CLI 命令建议扩展：

```bash
npm run cli -- scan
npm run cli -- connect --device 3C:DC:75:6F:C2:72
npm run cli -- send --device 3C:DC:75:6F:C2:72 --message ping
npm run cli -- audio-file --device 3C:DC:75:6F:C2:72 --file sample.wav
npm run cli -- wifi-audio --host 192.168.4.1 --file sample.wav
```

本机音频转换建议先依赖 ffmpeg：

```bash
ffmpeg -i input.wav -ac 1 -ar 16000 -f s16le output_16k_mono_s16le.raw
```

Node 端第一版可以：

```text
读取 raw PCM
按 20ms/40ms chunk 切块
按真实时间节奏发送
```

伪代码：

```ts
const chunkBytes = sampleRate * channels * bytesPerSample * chunkMs / 1000;
for each chunk:
  transport.writeAudio(chunk)
  await sleep(chunkMs)
```

## Android / Capacitor 下一步

Android 不应该直接复制 CLI 逻辑。应该新增：

```text
packages/transport-capacitor-ble/
```

接口实现：

```ts
class CapacitorBleTransport implements AgentTransport {
  scan(): Promise<AgentDevice[]>
  connect(deviceId: string): Promise<void>
  disconnect(): Promise<void>
  write(data: Uint8Array): Promise<void>
}
```

Android 权限需要关注：

```text
Android 12+:
  BLUETOOTH_SCAN
  BLUETOOTH_CONNECT

Android 11 and below:
  ACCESS_FINE_LOCATION often needed for BLE scan

WiFi/audio:
  INTERNET
  ACCESS_NETWORK_STATE
  RECORD_AUDIO if using microphone
```

Capacitor 与 Android SDK 关系：

```text
TS UI
  -> Capacitor JS API
  -> Capacitor Android plugin
  -> Kotlin/Java
  -> Android SDK Bluetooth/WiFi/Audio APIs
```

如果现成 BLE 插件不能满足 write-without-response 或 MTU/连接参数控制，就写自定义 Kotlin 插件。

## Electron/Desktop 下一步

Electron 不能交叉编译 Android。它只做桌面壳。

桌面 BLE 选择：

```text
Linux:
  BlueZ D-Bus bridge

Windows:
  WinRT Bluetooth LE

macOS:
  CoreBluetooth

Chrome/Electron renderer:
  Web Bluetooth 视 Chromium 能力和权限而定
```

因此桌面端也要 transport 分层：

```text
transport-bluez
transport-winrt-ble
transport-corebluetooth
transport-web-bluetooth
```

Electron UI 复用 `apps/web`，不要把业务写进 main process。

## 构建和运行记录

tools 仓库当前在移动盘上，不能创建 symlink，所以：

```bash
cd /run/media/howtion/thinkplus/1.8/live2dagenttools
npm install --no-bin-links
npm run build
npm run typecheck
node dist/apps/cli/src/index.js
```

已验证：

```text
npm install --no-bin-links -> OK
npm run build -> OK
npm run typecheck -> OK
CLI help -> OK
```

ESP32 无线固件构建记录：

```bash
cd /run/media/howtion/thinkplus/1.8/live2desp32agent
. scripts/esp-idf/export.sh >/tmp/live2d_idf_export.log
idf.py -B build_wireless build
idf.py -B build_wireless -p /dev/ttyACM0 flash
idf.py -B build_wireless -p /dev/ttyACM0 monitor
```

构建结果：

```text
live2desp32agent.bin size: 0x375e00
factory partition: 0x400000
free: 0x8a200, about 13%
```

无线后资源较紧，后续要优化 WiFi buffer：

```text
wifi dynamic rx buffer num: 32
wifi dynamic tx buffer num: 32
wifi static rx buffer num: 10
rx ba win: 6
```

可以后续在 `sdkconfig.defaults` 降低 WiFi buffer，但要边测边改。

## 已知问题

1. WiFi 未连接成功

```text
reason=201
```

先确认热点 2.4GHz。

2. 手机系统蓝牙列表不适合作为 BLE 调试入口

应该用：

```text
nRF Connect
LightBlue
自研 Capacitor App
```

ESP32-S3 是 BLE，不是经典蓝牙耳机/音箱设备。

3. BLE 已广播但手机“配对”不等于 GATT 连接

要看到 ESP32 日志：

```text
ble connect status=0
```

写入命令后要看到：

```text
ble cmd len=4 value="ping"
```

4. `bluetoothctl write` 不可靠

本机使用 BlueZ D-Bus `WriteValue`。

5. Electron 依赖下载很慢

默认根 build 不安装 Electron。需要桌面壳时单独：

```bash
npm run desktop:install
npm run desktop:dev
```

6. 当前 tools 仓库未启用 npm workspaces

原因是当前移动盘不支持 symlink。之后如果迁到正常开发目录，可以恢复 workspace 结构。

## 推荐接力顺序

### Step 1: ESP32 命令真正生效

```text
remote_protocol_parse_text()
remote_dispatch_command()
BLE ping -> pong/log
BLE wave -> Live2D wave
BLE speak:ATR_b102_015 -> 播放 flash voice
```

验收：

```text
npm run cli -- send --device 3C:DC:75:6F:C2:72 --message wave
板子执行 wave
```

### Step 2: WiFi 连接打通

```text
换 2.4GHz 热点
日志出现 got ip
记录 ESP32 IP
```

验收：

```text
remote_wireless: wifi connected ip=...
```

### Step 3: WiFi 简单 TCP/WebSocket command

先不要做音频，先用 WiFi 发 `ping/wave`。

验收：

```text
电脑 -> WiFi -> ESP32 -> wave
```

### Step 4: WiFi PCM 音频流

```text
16k mono s16le
20ms chunk
PSRAM ring buffer
CPU0 audio stream task
mono -> stereo
I2S write
```

验收：

```text
电脑发送 raw PCM 文件
ESP32 播放完整
无明显卡顿
underflow 计数可见
```

### Step 5: Android Capacitor BLE 控制

```text
transport-capacitor-ble
扫描 esplive2d
连接
发送 ping/wave/speak
```

验收：

```text
Android APK 控制板子动作
```

### Step 6: Android WiFi 音频

```text
Android 录音或文件
转 16k mono PCM
WiFi 发给 ESP32
```

验收：

```text
手机向 ESP32 实时传音频并播放
```

## 不建议的路线

不要把音频主路线做成 BLE 大流量传输，除非只是实验。

不要让 BLE callback 直接操作 Live2D model 或直接写 I2S。

不要把 Android/Electron 平台 API 写进 `interaction-core`。

不要把 Electron 当 Android 打包方案。

不要一开始做复杂 mixer、Opus、UDP jitter buffer；先让 PCM/WebSocket 跑通。

不要继续低质量纹理采样/强行 mesh 简化优化 Live2D，之前已经验证画质不可接受。

## 快速命令备忘

ESP32 monitor：

```bash
cd /run/media/howtion/thinkplus/1.8/live2desp32agent
. scripts/esp-idf/export.sh >/tmp/live2d_idf_export.log
idf.py -B build_wireless -p /dev/ttyACM0 monitor
```

电脑扫描 BLE：

```bash
bluetoothctl
power on
agent on
default-agent
scan on
```

电脑连接 BLE：

```bash
connect 3C:DC:75:6F:C2:72
```

tools 构建：

```bash
cd /run/media/howtion/thinkplus/1.8/live2dagenttools
npm install --no-bin-links
npm run build
npm run typecheck
```

tools CLI：

```bash
npm run cli -- send --device 3C:DC:75:6F:C2:72 --message ping
npm run cli -- send --device 3C:DC:75:6F:C2:72 --message wave
npm run cli -- send --device 3C:DC:75:6F:C2:72 --message speak:ATR_b102_015
```
