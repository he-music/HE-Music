import { watch, type Ref } from "vue";
import packageJson from "@/../package.json";
import { platform } from "@/platform";
import { UpdatesSession, updatesSession } from "@/platform/updatesSession";
import { hasReachedUpdateVersion } from "@/utils/updateVersion";

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const POLL_INTERVAL = 60 * 1000;

/** The main shell owns updates; leaving settings must not end a native installation. */
export function createShellUpdatesSession(
  automaticCheck: () => boolean,
  skippedVersion?: Ref<string>,
) {
  if (!platform.lifecycle || !platform.updates) return;
  const session = new UpdatesSession(platform.updates);
  let disposed = false;
  let starting: Promise<void> | undefined;
  let lastCheckedAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopChecking: (() => void) | undefined;

  async function checkAutomatically(): Promise<void> {
    const phase = session.state.value?.phase;
    if (
      disposed ||
      !session.ready.value ||
      updatesSession.value !== session ||
      !automaticCheck() ||
      session.busy.value ||
      session.checking.value ||
      phase === "unavailable" ||
      phase === "inactive" ||
      phase === "installing" ||
      phase === "installed" ||
      (lastCheckedAt !== undefined && Date.now() - lastCheckedAt < CHECK_INTERVAL)
    )
      return;
    await session.check();
  }

  async function start(): Promise<void> {
    if (skippedVersion && hasReachedUpdateVersion(packageJson.version, skippedVersion.value)) {
      skippedVersion.value = "";
    }
    await session.start();
    if (disposed || !session.ready.value) return;
    // 手动与自动检查都从发起时重新计时，失败后也不立即重试。
    stopChecking = watch(
      session.checking,
      (checking) => {
        if (checking) lastCheckedAt = Date.now();
      },
      { flush: "sync" },
    );
    timer = setInterval(() => {
      void checkAutomatically().catch((error: unknown) => console.error("后台检查更新失败", error));
    }, POLL_INTERVAL);
    await checkAutomatically();
  }

  return {
    start() {
      if (disposed) return Promise.reject(new Error("Update session ended"));
      return (starting ??= start());
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      stopChecking?.();
      return session.dispose();
    },
  };
}
