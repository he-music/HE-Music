import { filesSession } from "./filesSession";
import { flushApplicationWrites } from "./applicationStorage";

declare global {
  interface Window {
    __heMusicPrepareQuit?: () => Promise<boolean>;
  }
}

/** Also used by the official updater's native restart button. */
export function installApplicationQuitHandler(reportFailure: () => void) {
  let pending: Promise<boolean> | undefined;
  let disposed = false;
  const prepare = () => {
    if (disposed) return Promise.resolve(false);
    return (pending ??= (async () => {
      try {
        // Fail before stopping file work when existing writes cannot be saved.
        await flushApplicationWrites();
        const owner = filesSession.value?.capturePreferencesResetOwner();
        await owner?.dispose();
        await flushApplicationWrites();
        return !disposed;
      } catch (error) {
        console.error("退出前保存应用数据失败", error);
        if (!disposed) reportFailure();
        return false;
      } finally {
        pending = undefined;
      }
    })());
  };
  window.__heMusicPrepareQuit = prepare;
  return () => {
    disposed = true;
    if (window.__heMusicPrepareQuit === prepare) delete window.__heMusicPrepareQuit;
  };
}
