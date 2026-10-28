import { ref, shallowRef } from "vue";
import type {
  LyricsAction,
  LyricsBounds,
  LyricsClock,
  LyricsSnapshot,
  LyricsWindowState,
  PlatformDesktopLyrics,
} from "@/platform/desktopLyrics";

type PageProvider = Pick<
  PlatformDesktopLyrics,
  "attach" | "getState" | "setBounds" | "close" | "command" | "onSnapshot" | "onClock" | "onWindow"
>;

/** 子页只消费已存在的主会话；处置时不撤销主会话。 */
export function createDesktopLyricsConsumer(provider: PageProvider | undefined) {
  const status = ref<"connecting" | "connected" | "failed">("connecting");
  const snapshot = shallowRef<LyricsSnapshot>();
  const clock = shallowRef<LyricsClock>();
  const windowState = shallowRef<LyricsWindowState>();
  let epoch = 0;
  let snapshotSeq = -1;
  let seq = -1;
  let pendingClock: LyricsClock | undefined;
  let disposed = false;
  let started = false;
  const subscriptions: Array<() => void> = [];

  function acceptEpoch(incoming: number) {
    if (disposed || incoming < epoch) return false;
    if (incoming > epoch) {
      epoch = incoming;
      snapshotSeq = -1;
      seq = -1;
      snapshot.value = undefined;
      clock.value = undefined;
      windowState.value = undefined;
      pendingClock = undefined;
    }
    return true;
  }

  function acceptClock(value: LyricsClock) {
    if (!acceptEpoch(value.epoch)) return;
    if (!snapshot.value || value.trackKey !== snapshot.value.trackKey) {
      if (value.seq > seq && (!pendingClock || value.seq > pendingClock.seq)) pendingClock = value;
      return;
    }
    if (value.seq <= seq) return;
    seq = value.seq;
    clock.value = value;
  }

  function acceptSnapshot(value: LyricsSnapshot) {
    if (!acceptEpoch(value.epoch) || value.seq <= snapshotSeq) return;
    // 晚到 Attach 的完整数据仍可补齐歌词，但不能回退已收到的时钟或曲目。
    if (value.seq < seq && value.trackKey !== snapshot.value?.trackKey) return;
    snapshotSeq = value.seq;
    snapshot.value = value;
    if (value.seq > seq) {
      seq = value.seq;
      clock.value = value;
    }
    if (
      pendingClock &&
      (pendingClock.trackKey === value.trackKey || pendingClock.seq <= value.seq)
    ) {
      const pending = pendingClock;
      pendingClock = undefined;
      if (pending.trackKey === value.trackKey) acceptClock(pending);
    }
  }

  function acceptWindow(value: LyricsWindowState) {
    if (!acceptEpoch(value.epoch)) return;
    if (windowState.value && value.revision <= windowState.value.revision) return;
    windowState.value = value;
    if (value.failure) status.value = "failed";
  }

  function clearSubscriptions() {
    for (const unsubscribe of subscriptions.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // 单个失效订阅不得阻断其余订阅的释放。
      }
    }
  }

  function fail() {
    if (!disposed) status.value = "failed";
  }

  async function start() {
    if (started || disposed) return;
    started = true;
    if (!provider) {
      fail();
      return;
    }
    try {
      subscriptions.push(provider.onSnapshot(acceptSnapshot));
      subscriptions.push(provider.onClock(acceptClock));
      subscriptions.push(provider.onWindow(acceptWindow));
      const attachment = await provider.attach();
      if (disposed) return;
      acceptWindow(attachment.window);
      if (attachment.snapshot) acceptSnapshot(attachment.snapshot);
      status.value = windowState.value?.failure ? "failed" : "connected";
    } catch {
      fail();
      clearSubscriptions();
    }
  }

  async function command(action: LyricsAction) {
    if (disposed || status.value !== "connected" || !provider || !epoch) return;
    try {
      await provider.command({ epoch, trackKey: snapshot.value?.trackKey ?? "", action });
    } catch {
      fail();
    }
  }

  async function setBounds(bounds: LyricsBounds) {
    if (disposed || status.value !== "connected" || !provider || !epoch) return;
    try {
      acceptWindow(await provider.setBounds(epoch, bounds));
    } catch {
      fail();
    }
  }

  async function refreshBounds() {
    if (disposed || status.value !== "connected" || !provider || !epoch) return;
    try {
      acceptWindow(await provider.getState(epoch));
    } catch {
      fail();
    }
  }

  async function close() {
    if (disposed || !provider || !epoch) return;
    try {
      acceptWindow(await provider.close(epoch));
    } catch {
      fail();
    }
  }

  function dispose() {
    disposed = true;
    clearSubscriptions();
    pendingClock = undefined;
  }

  return {
    status,
    snapshot,
    clock,
    windowState,
    start,
    command,
    setBounds,
    refreshBounds,
    close,
    dispose,
  };
}
