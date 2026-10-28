import { platform } from "@/platform";
import { UpdatesSession } from "@/platform/updatesSession";

/** The main shell owns updates; leaving settings must not end a native installation. */
export function createShellUpdatesSession(automaticCheck: () => boolean) {
  if (!platform.lifecycle || !platform.updates) return;
  const session = new UpdatesSession(platform.updates);
  let disposed = false;
  return {
    async start() {
      await session.start();
      if (
        disposed ||
        !session.ready.value ||
        !automaticCheck() ||
        session.busy.value ||
        session.state.value?.phase === "unavailable"
      )
        return;
      const state = await session.check();
      if (!disposed && session.ready.value && state.phase === "available") {
        const { openMygoUpdate } = await import("@/utils/mygoUpdateModal");
        if (!disposed) await openMygoUpdate(session);
      }
    },
    dispose() {
      disposed = true;
      return session.dispose();
    },
  };
}
