import { app, BrowserWindow, dialog } from "electron";
import { composeApplication } from "./composition-root";
import { parseLaunchOptions } from "./launch-options";
import { claimSingleInstance } from "./single-instance";

function failStartup(error: unknown): void {
  console.error("Unable to open Heart on Stream.", error);
  app.exit(1);
}

function showRelaunchMessage(window: BrowserWindow, message: string): void {
  void dialog
    .showMessageBox(window, { type: "info", message })
    .catch((error) => {
      console.error("Unable to show the launch options message.", error);
    });
}

const options = parseLaunchOptions(process.argv.slice(2));
if (
  claimSingleInstance(
    app,
    () => BrowserWindow.getAllWindows()[0],
    options,
    showRelaunchMessage,
  )
) {
  void app
    .whenReady()
    .then(() => {
      composeApplication(options).openWindow();
    })
    .catch(failStartup);

  app.on("window-all-closed", () => {
    app.quit();
  });
}
