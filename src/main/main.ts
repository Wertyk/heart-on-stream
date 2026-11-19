import { app, BrowserWindow } from "electron";
import { composeApplication } from "./composition-root";
import { parseLaunchOptions } from "./launch-options";
import { claimSingleInstance } from "./single-instance";

function failStartup(error: unknown): void {
  console.error("Unable to open Heart on Stream.", error);
  app.exit(1);
}

if (claimSingleInstance(app, () => BrowserWindow.getAllWindows()[0])) {
  const options = parseLaunchOptions(process.argv.slice(2));
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
