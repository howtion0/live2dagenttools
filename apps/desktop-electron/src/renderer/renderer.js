const api = window.live2dAudio;

const state = {
  audio: null,
  audioList: [],
  selectedDevice: null,
  devices: [],
  running: false,
};

const $ = (id) => document.getElementById(id);

const refs = {
  pickButton: $("pickButton"),
  pickFolderButton: $("pickFolderButton"),
  scanButton: $("scanButton"),
  startButton: $("startButton"),
  stopButton: $("stopButton"),
  clearLogButton: $("clearLogButton"),
  adapterInput: $("adapterInput"),
  brokerInput: $("brokerInput"),
  mqttDeviceInput: $("mqttDeviceInput"),
  transportGroup: $("transportGroup"),
  modeGroup: $("modeGroup"),
  deviceList: $("deviceList"),
  queueList: $("queueList"),
  stateText: $("stateText"),
  log: $("log"),
  fillProgress: $("fillProgress"),
};

refs.pickButton.addEventListener("click", async () => {
  try {
    setStateText("正在探测音频...");
    const audio = await api.pickAudio();
    if (!audio) {
      setStateText("未选择音频");
      return;
    }
    state.audio = audio;
    state.audioList = [audio];
    renderAudio(audio);
    renderQueue();
    appendLog(`audio ${audio.path}`);
    updateStartButton();
    setStateText("音频已就绪");
  } catch (error) {
    showError(error);
  }
});

refs.pickFolderButton.addEventListener("click", async () => {
  try {
    setStateText("正在扫描目录音频...");
    const audios = await api.pickAudioFolder();
    if (!audios.length) {
      setStateText("目录里没有可发送音频");
      return;
    }
    state.audioList = audios;
    state.audio = audios[0];
    renderAudio(audios[0]);
    renderQueue();
    appendLog(`audio batch files=${audios.length}`);
    updateStartButton();
    setStateText(`队列已就绪：${audios.length} 个文件`);
  } catch (error) {
    showError(error);
  }
});

refs.scanButton.addEventListener("click", async () => {
  try {
    refs.scanButton.disabled = true;
    setStateText("正在扫描蓝牙设备...");
    state.devices = await api.scanDevices(refs.adapterInput.value || "hci0");
    renderDevices();
    appendLog(`scan devices=${state.devices.length}`);
    setStateText(state.devices.length ? "请选择蓝牙设备" : "没有扫到设备");
  } catch (error) {
    showError(error);
  } finally {
    refs.scanButton.disabled = false;
  }
});

refs.transportGroup.addEventListener("selected", () => {
  renderTransport();
  updateStartButton();
});
refs.transportGroup.addEventListener("change", () => {
  renderTransport();
  updateStartButton();
});
refs.brokerInput.addEventListener("input", updateStartButton);

refs.startButton.addEventListener("click", async () => {
  const transport = refs.transportGroup.selected === "mqtt" ? "mqtt" : "ble";
  if (!state.audioList.length || (transport === "ble" && !state.selectedDevice)) {
    updateStartButton();
    return;
  }
  try {
    resetStats();
    state.running = true;
    setRunningUi(true);
    await api.startAudio({
      transport,
      device: state.selectedDevice?.id || "",
      inputPath: state.audioList[0].path,
      inputPaths: state.audioList.map((audio) => audio.path),
      mode: refs.modeGroup.selected === "pi" ? "pi" : "watermark",
      adapter: refs.adapterInput.value || "hci0",
      broker: refs.brokerInput.value || "mqtt://192.168.135.73:1883",
      deviceId: refs.mqttDeviceInput.value || "live2d-atri",
    });
    setStateText("发送中");
  } catch (error) {
    state.running = false;
    setRunningUi(false);
    showError(error);
  }
});

refs.stopButton.addEventListener("click", async () => {
  await api.stopAudio();
  state.running = false;
  setRunningUi(false);
  setStateText("已停止");
});

refs.clearLogButton.addEventListener("click", () => {
  refs.log.textContent = "";
});

api.onAudioEvent((payload) => {
  handleAudioEvent(payload);
});

function renderAudio(audio) {
  $("fileName").textContent = audio.name;
  $("formatName").textContent = audio.formatName || "-";
  $("fileBytes").textContent = formatBytes(audio.bytes);
  $("duration").textContent = audio.durationSeconds === null ? "-" : `${audio.durationSeconds.toFixed(2)} s`;
  $("audioCodec").textContent = audio.audioCodec || "-";
  $("sampleRate").textContent = audio.sampleRate ? `${audio.sampleRate} Hz` : "-";
  $("channels").textContent = audio.channels ?? "-";
  $("bitRate").textContent = audio.bitRate ? `${Math.round(audio.bitRate / 1000)} kbps` : "-";
  $("mediaSize").textContent = audio.width && audio.height ? `${audio.width} x ${audio.height}` : "纯音频";
}

function renderQueue() {
  refs.queueList.textContent = "";
  if (state.audioList.length <= 1) {
    return;
  }
  for (const [index, audio] of state.audioList.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `queue-item${state.audio?.path === audio.path ? " selected" : ""}`;
    item.textContent = `${index + 1}. ${audio.name} · ${formatBytes(audio.bytes)}`;
    item.addEventListener("click", () => {
      state.audio = audio;
      renderAudio(audio);
      renderQueue();
    });
    refs.queueList.appendChild(item);
  }
}

function renderDevices() {
  refs.deviceList.textContent = "";
  for (const device of state.devices) {
    const button = document.createElement("wired-button");
    button.className = `device${state.selectedDevice?.id === device.id ? " selected" : ""}`;
    button.setAttribute("role", "button");
    button.innerHTML = `<strong>${escapeHtml(device.name || "Unknown")}</strong><span>${escapeHtml(device.id)}</span><small>RSSI ${device.rssi ?? "-"}</small>`;
    button.addEventListener("click", () => {
      state.selectedDevice = device;
      renderDevices();
      appendLog(`device ${device.id}`);
      updateStartButton();
      setStateText("蓝牙设备已选择");
    });
    refs.deviceList.appendChild(button);
  }
}

function updateStartButton() {
  const transport = refs.transportGroup.selected === "mqtt" ? "mqtt" : "ble";
  const transportReady = transport === "mqtt" ? Boolean(refs.brokerInput.value) : Boolean(state.selectedDevice);
  refs.startButton.disabled = !state.audioList.length || !transportReady || state.running;
}

function setRunningUi(running) {
  refs.pickButton.disabled = running;
  refs.pickFolderButton.disabled = running;
  refs.scanButton.disabled = running;
  refs.startButton.disabled = running;
  refs.stopButton.disabled = !running;
}

function handleAudioEvent(payload) {
  const event = String(payload.event || "event");
  if (event === "produce" || event === "send" || event === "status" || event === "wait" || event === "end") {
    renderStats(payload);
  }
  if (event === "close") {
    state.running = false;
    setRunningUi(false);
    setStateText(Number(payload.code) === 0 ? "发送完成" : `发送退出 code=${payload.code ?? "-"}`);
  }
  appendLog(formatEvent(payload));
}

function renderStats(payload) {
  $("produced").textContent = formatBytes(Number(payload.produced || 0));
  $("sent").textContent = formatBytes(Number(payload.sent || 0));
  $("packets").textContent = String(payload.packets || 0);
  $("fill").textContent = formatBytes(Number(payload.fill || 0));
  $("free").textContent = formatBytes(Number(payload.free || 0));
  $("received").textContent = formatBytes(Number(payload.received || 0));
  $("outstanding").textContent = formatBytes(Number(payload.outstanding || 0));
  $("budget").textContent = `${Math.round(Number(payload.controllerBudget || 0))} B/tick`;
  refs.fillProgress.value = Math.max(0, Math.min(131072, Number(payload.fill || 0)));
}

function resetStats() {
  renderStats({
    produced: 0,
    sent: 0,
    packets: 0,
    fill: 0,
    free: 0,
    received: 0,
    outstanding: 0,
    controllerBudget: 0,
  });
}

function renderTransport() {
  const transport = refs.transportGroup.selected === "mqtt" ? "mqtt" : "ble";
  document.querySelector(".device-panel").dataset.transport = transport;
  setStateText(transport === "mqtt" ? "等待音频和 MQTT broker" : "等待音频和蓝牙设备");
}

function setStateText(text) {
  refs.stateText.textContent = text;
}

function appendLog(line) {
  const stamp = new Date().toLocaleTimeString();
  refs.log.textContent += `[${stamp}] ${line}\n`;
  refs.log.scrollTop = refs.log.scrollHeight;
}

function formatEvent(payload) {
  const event = String(payload.event || "event");
  if (event === "produce") {
    return `produce decoded=${formatBytes(Number(payload.produced || 0))} fill=${formatBytes(Number(payload.fill || 0))}`;
  }
  if (event === "send" || event === "status" || event === "wait") {
    return `${event} sent=${formatBytes(Number(payload.sent || 0))} packets=${payload.packets || 0} fill=${formatBytes(Number(payload.fill || 0))} free=${formatBytes(Number(payload.free || 0))} ack=${formatBytes(Number(payload.received || 0))} waits=${payload.waits || 0}`;
  }
  if (event === "end" || event === "close") {
    return `${event} ${JSON.stringify(payload)}`;
  }
  if (payload.message) {
    return `${event} ${payload.message}`;
  }
  return `${event} ${JSON.stringify(payload)}`;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStateText(message);
  appendLog(`error ${message}`);
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "-";
  const units = ["B", "KiB", "MiB", "GiB"];
  let size = value;
  let unit = 0;
  while (Math.abs(size) >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(size)} ${units[unit]}` : `${size.toFixed(1)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

resetStats();
renderTransport();
updateStartButton();
