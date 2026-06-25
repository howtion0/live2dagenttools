const deviceInput = document.querySelector("#deviceInput");
const customCommand = document.querySelector("#customCommand");
const sendCustom = document.querySelector("#sendCustom");
const dropZone = document.querySelector("#dropZone");
const fileInput = document.querySelector("#fileInput");
const sendAudioButton = document.querySelector("#sendAudio");
const audioName = document.querySelector("#audioName");
const audioInfo = document.querySelector("#audioInfo");
const logNode = document.querySelector("#log");

let convertedAudioId = "";

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    sendCommand(button.dataset.command);
  });
});

sendCustom.addEventListener("click", () => {
  sendCommand(customCommand.value.trim());
});

sendAudioButton.addEventListener("click", async () => {
  if (!convertedAudioId) {
    appendLog("No converted audio ready.");
    return;
  }
  const device = getDevice();
  if (!device) return;
  await requestJson("/api/send-audio", { device, audioId: convertedAudioId }, `Sent audio to ${device}.`);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragging");
});

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  const file = event.dataTransfer.files[0];
  if (file) {
    await convertFile(file);
  }
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (file) {
    await convertFile(file);
  }
});

async function sendCommand(message) {
  if (!message) {
    appendLog("Command is empty.");
    return;
  }
  const device = getDevice();
  if (!device) return;
  await requestJson("/api/send-command", { device, message }, `Sent ${message} to ${device}.`);
}

async function convertFile(file) {
  appendLog(`Converting ${file.name} with ffmpeg...`);
  sendAudioButton.disabled = true;
  convertedAudioId = "";
  const response = await fetch("/api/convert", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  });
  const data = await response.json();
  if (!response.ok) {
    appendLog(`Convert failed: ${data.error || response.statusText}`);
    return;
  }
  convertedAudioId = data.id;
  audioName.textContent = data.name;
  audioInfo.textContent = `${formatBytes(data.sourceBytes)} source / dynamic ffmpeg`;
  sendAudioButton.disabled = false;
  appendLog(`Loaded ${data.name}: ${formatBytes(data.sourceBytes)}. It will stream as ${data.sampleRate} Hz mono s16le when sent.`);
}

async function requestJson(url, body, successMessage) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      appendLog(`Request failed: ${data.error || response.statusText}`);
      return;
    }
    appendLog(successMessage);
  } catch (error) {
    appendLog(error instanceof Error ? error.message : String(error));
  }
}

function getDevice() {
  const device = deviceInput.value.trim();
  if (!device) {
    appendLog("Enter the BLE MAC first.");
    return "";
  }
  return device;
}

function appendLog(value) {
  const time = new Date().toLocaleTimeString();
  logNode.textContent = `[${time}] ${value}\n${logNode.textContent}`;
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}
