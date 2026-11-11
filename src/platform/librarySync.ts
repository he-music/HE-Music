interface LibrarySyncDependencies {
  refresh(signal: AbortSignal): Promise<void>;
  canRefresh(): boolean;
  visible(): boolean;
  windowEvents: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  documentEvents: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  report(error: unknown): void;
}

/** 仅在曲库页面可见时同步；恢复前台及时检查，连续浏览时每分钟检查一次。 */
export class LibrarySync {
  private active = false;
  private running?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private lastRefresh = 0;

  constructor(private readonly deps: LibrarySyncDependencies) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.lastRefresh = Date.now();
    this.deps.windowEvents.addEventListener("focus", this.onFocus);
    this.deps.documentEvents.addEventListener("visibilitychange", this.onVisibility);
    this.schedule();
  }

  stop(): void {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running?.abort();
    this.deps.windowEvents.removeEventListener("focus", this.onFocus);
    this.deps.documentEvents.removeEventListener("visibilitychange", this.onVisibility);
  }

  async request(force = false): Promise<void> {
    if (
      !this.active ||
      this.running ||
      !this.deps.visible() ||
      !this.deps.canRefresh() ||
      (!force && Date.now() - this.lastRefresh < 5000)
    )
      return;
    const controller = new AbortController();
    this.running = controller;
    this.lastRefresh = Date.now();
    try {
      await this.deps.refresh(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.deps.report(error);
    } finally {
      if (this.running === controller) this.running = undefined;
    }
  }

  private readonly onFocus = () => void this.request();
  private readonly onVisibility = () => {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.deps.visible()) this.running?.abort();
    else {
      void this.request();
      this.schedule();
    }
  };

  private schedule(): void {
    if (!this.active || !this.deps.visible() || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.request().finally(() => this.schedule());
    }, 60_000);
  }
}
