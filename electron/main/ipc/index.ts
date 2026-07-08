import initFileIpc from "./ipc-file";
import initLyricIpc from "./ipc-lyric";
import initShortcutIpc from "./ipc-shortcut";
import initStoreIpc from "./ipc-store";
import initSystemIpc from "./ipc-system";
import initThumbarIpc from "./ipc-thumbar";
import initTrayIpc from "./ipc-tray";
import initUpdateIpc from "./ipc-update";
import initWindowsIpc from "./ipc-window";
import initProtocolIpc from "./ipc-protocol";

/**
 * 初始化全部 IPC 通信
 * @returns void
 */
const initIpc = (): void => {
  initSystemIpc();
  initWindowsIpc();
  initUpdateIpc();
  initFileIpc();
  initTrayIpc();
  initLyricIpc();
  initStoreIpc();
  initThumbarIpc();
  initShortcutIpc();
  initProtocolIpc();
};

export default initIpc;
