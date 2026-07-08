import { app, ipcMain } from "electron";
import { processLog } from "../logger";

const initProtocolIpc = (): void => {
  ipcMain.on("register-protocol", (_, protocols: string[]) => {
    for (const protocol of protocols) {
      const result = app.setAsDefaultProtocolClient(protocol);
      processLog.info("🔗 Registered custom protocol", protocol, result);
    }
  });

  ipcMain.on("unregister-protocol", (_, protocols: string[]) => {
    for (const protocol of protocols) {
      const result = app.removeAsDefaultProtocolClient(protocol);
      processLog.info("🔗 Unregistered custom protocol", protocol, result);
    }
  });
};

export default initProtocolIpc;
