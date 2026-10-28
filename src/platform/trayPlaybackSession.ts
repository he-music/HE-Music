import type { PlatformLifecycle } from "./types";
import type { TrayPlaybackState, TrayRequest } from "./mygo.bindings";

export type TrayPlaybackSource = Omit<TrayPlaybackState, "epoch" | "revision">;

/** 低频托盘快照串行发送；业务状态一变化就同步废弃旧菜单回执。 */
export class TrayPlaybackSession {
  private epoch = 0;
  private revision = 0;
  private disposed = false;
  private source: TrayPlaybackSource = {
    trackKey: "",
    playing: false,
    hasSong: false,
    liked: false,
    canFavorite: false,
    playMode: "repeat",
    canSetMode: false,
  };
  private latest?: TrayPlaybackState;
  private pending?: TrayPlaybackState;
  private accepted?: TrayPlaybackState;
  private sending?: Promise<void>;

  constructor(
    private readonly provider: Pick<PlatformLifecycle, "syncPlayback">,
    private readonly reportFailure: () => void,
  ) {}

  get ready() {
    return !this.disposed && this.epoch > 0;
  }

  async start(epoch: number): Promise<void> {
    if (this.disposed || this.epoch || !Number.isSafeInteger(epoch) || epoch <= 0) {
      throw new Error("Invalid tray session");
    }
    this.epoch = epoch;
    this.queue();
    await this.flush();
  }

  update(source: TrayPlaybackSource): void {
    if (this.disposed) return;
    this.source = {
      trackKey: source.trackKey,
      playing: source.playing,
      hasSong: source.hasSong,
      liked: source.liked,
      canFavorite: source.canFavorite,
      playMode: source.playMode,
      canSetMode: source.canSetMode,
    };
    if (!this.epoch) return;
    this.queue();
    void this.flush().catch(this.reportFailure);
  }

  private queue(): void {
    this.accepted = undefined;
    if (this.revision >= Number.MAX_SAFE_INTEGER) {
      this.dispose();
      throw new Error("Tray revision exhausted");
    }
    this.latest = { ...this.source, epoch: this.epoch, revision: ++this.revision };
    this.pending = this.latest;
  }

  private flush(): Promise<void> {
    if (this.sending) return this.sending;
    const task = (async () => {
      // 合并同一同步提交内的列表、索引、模式和 busy 变化。
      await Promise.resolve();
      while (!this.disposed && this.pending) {
        const payload = this.pending;
        this.pending = undefined;
        await this.provider.syncPlayback({ ...payload });
        if (!this.disposed && this.latest === payload) this.accepted = payload;
      }
    })();
    this.sending = task.finally(() => {
      this.sending = undefined;
      if (!this.disposed && this.pending) void this.flush().catch(this.reportFailure);
    });
    return this.sending;
  }

  capture(request: TrayRequest): Readonly<TrayRequest> | undefined {
    const state = this.accepted;
    if (
      !this.ready ||
      !state ||
      state !== this.latest ||
      request.epoch !== state.epoch ||
      request.revision !== state.revision ||
      request.trackKey !== state.trackKey
    )
      return;
    switch (request.action) {
      case "open-settings":
        if (request.favorite !== undefined || request.mode !== undefined) return;
        break;
      case "previous":
      case "toggle":
      case "next":
        if (!state.hasSong || request.favorite !== undefined || request.mode !== undefined) return;
        break;
      case "set-favorite":
        if (
          !state.hasSong ||
          !state.canFavorite ||
          typeof request.favorite !== "boolean" ||
          request.favorite === state.liked ||
          request.mode !== undefined
        )
          return;
        break;
      case "set-play-mode":
        if (
          !state.hasSong ||
          !state.canSetMode ||
          request.favorite !== undefined ||
          !["repeat", "repeat-once", "shuffle"].includes(request.mode ?? "")
        )
          return;
        break;
      default:
        return;
    }
    return Object.freeze({
      epoch: request.epoch,
      revision: request.revision,
      trackKey: request.trackKey,
      action: request.action,
      favorite: request.favorite,
      mode: request.mode,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.accepted = undefined;
    this.pending = undefined;
    this.latest = undefined;
  }
}
