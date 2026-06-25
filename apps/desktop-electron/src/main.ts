import { app, BrowserWindow } from "electron";

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadURL("data:text/html,<h1>Live2DAgentTools Desktop</h1><p>Desktop shell placeholder.</p>");
}

app.whenReady().then(createWindow).catch((error: unknown) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
