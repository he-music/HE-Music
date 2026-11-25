import { shallowRef, watch } from "vue";
import type { PlatformMiniPlayer } from "./miniPlayer";
import type { MiniPlayerCommand, MiniPlayerSnapshot } from "./mygo.bindings";

type OwnerProvider = Pick<PlatformMiniPlayer, "open" | "publish" | "onClosed" | "onCommand">;

export const miniPlayerSession = shallowRef<ReturnType<typeof createMiniPlayerSession>>();

export function createMiniPlayerSession(
  provider: OwnerProvider,
  readPlayback: () => MiniPlayerSnapshot,
  execute: (command: MiniPlayerCommand) => Promise<void>,
  report: (error: unknown) => void,
) {
  let active = 0;
  let lastClosed = 0;
  let disposed = false;
  let opening: Promise<void> | undefined;
  let stopPlayback: (() => void) | undefined;
  let pending: { generation: number; playback: MiniPlayerSnapshot } | undefined;
  let publishing = false;

  async function publish() {
    if (publishing) return;
    publishing = true;
    try {
      while (pending) {
        const { generation, playback } = pending;
        pending = undefined;
        try {
          await provider.publish(generation, playback);
        } catch (error) {
          if (!disposed && active === generation) report(error);
        }
      }
    } finally {
      publishing = false;
    }
  }

  const offClosed = provider.onClosed(({ generation, failed }) => {
    lastClosed = Math.max(lastClosed, generation);
    if (active === generation) {
      active = 0;
      pending = undefined;
      stopPlayback?.();
      stopPlayback = undefined;
      if (failed) report(new Error("Mini player window closed before it was usable"));
    } else if (opening && !active && failed) {
      report(new Error("Mini player window could not be opened"));
    }
  });

  const offCommand = provider.onCommand((command) => {
    if (disposed || !active || command.generation !== active) return;
    const current = readPlayback();
    if (!current.trackKey || command.trackKey !== current.trackKey) return;
    switch (command.action) {
      case "toggle":
        break;
      case "previous":
        if (!current.canPrevious) return;
        break;
      case "next":
        if (!current.canNext) return;
        break;
      case "favorite":
        if (!current.canFavorite || command.favorite === current.favorite) return;
        break;
      default:
        return;
    }
    void execute(command).catch((error: unknown) => {
      if (!disposed && active === command.generation) report(error);
    });
  });

  return {
    open(minimizeMain = false) {
      if (disposed || opening) return;
      opening = provider
        .open(readPlayback(), minimizeMain)
        .then((generation) => {
          if (disposed || generation <= lastClosed || generation === active) return;
          stopPlayback?.();
          active = generation;
          stopPlayback = watch(
            readPlayback,
            (playback) => {
              pending = { generation, playback };
              void publish();
            },
            { immediate: true },
          );
        })
        .catch((error: unknown) => {
          if (!disposed) report(error);
        })
        .finally(() => (opening = undefined));
      return opening;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = 0;
      pending = undefined;
      stopPlayback?.();
      offClosed();
      offCommand();
    },
  };
}
