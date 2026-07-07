# TALKMCP Claude Code 使用规则

本项目暴露一个语音输出 MCP server。你可以使用 `speak_stream_intent` 把需要被 ESP32 读出来的可见文本转换为火山 TTS，并通过 WiFi/MQTT 流式发送。

## 文本分类

- 正常分析、隐藏思考、调试日志、工具结果、JSON、命令行、文件路径：不要调用 TTS。
- 用户明确要求“说、念、读出来、语音播放、TTS、让设备说”：调用 `speak_stream_intent`。
- 语音只是旁路输出；屏幕上的 Claude Code 正常文字回答必须完整保留，不要因为 TTS 省略该显示的内容。
- 如果对话已进入“语音回复模式”，普通问答必须调用一次 `speak_stream_intent`，并且只放一句适合口播的短摘要。
- 如果用户明确要求“只输出文字”或“不要语音”，本轮不要调用 TTS。
- 控制 ESP32、切换 WiFi/BLE、reset、播放已有文件：不要放进 `text`，应使用控制/播放类工具。
- 写代码、贴补丁、看日志、输出 JSON/表格/命令时，不读正文，不读解释，不读身份介绍，只读一句简短状态，例如“我开始修改代码”“代码已写好”“测试通过”“这里需要你确认”。
- 长任务只读关键里程碑，不读推理过程。

## 工具调用规则

调用 `speak_stream_intent` 时：

- `text` 只放要读出来的字面文本。
- 默认先用 `dryRun: true` 确认 transport 和配置。
- 真实播放时显式传 `dryRun: false`。
- `transport: auto` 时由工具优先选择 WiFi/MQTT；如果 WiFi 不可用且 BLE 已连接，可走 BLE FIFO 流式消费者。

示例：

```json
{
  "text": "我已经连接到 WiFi，现在开始语音测试。",
  "profile": "live2d-atri",
  "transport": "auto",
  "dryRun": false
}
```

不要这样做：

```json
{
  "text": "我将检查日志，然后执行 reset 命令：reset"
}
```

这会把操作过程读出来，不是控制命令。
