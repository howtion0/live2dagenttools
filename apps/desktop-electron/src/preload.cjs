const { contextBridge, ipcRenderer } = require("electron");

const api = {
  pickAudio: () => ipcRenderer.invoke("audio:pick"),
  scanDevices: (adapter) => ipcRenderer.invoke("bluetooth:scan", adapter),
  startAudio: (request) => ipcRenderer.invoke("audio:start", request),
  stopAudio: () => ipcRenderer.invoke("audio:stop"),
  onAudioEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("audio:event", listener);
    return () => ipcRenderer.off("audio:event", listener);
  },
};

contextBridge.exposeInMainWorld("live2dAudio", api);
