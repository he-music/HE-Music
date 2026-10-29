import { readonly, shallowRef } from "vue";

export interface WindowAppearanceState {
  useBorderless: boolean;
  appliedUseBorderless: boolean;
  restartRequired: boolean;
  loadFailed: boolean;
}
export interface PlatformWindowAppearance {
  current(): Promise<WindowAppearanceState>;
  save(useBorderless: boolean): Promise<WindowAppearanceState>;
}

/** Shared only by the active main shell; saved settings never change this window's frame. */
export const windowAppearanceSession = shallowRef<WindowAppearanceSession>();

export class WindowAppearanceSession {
  private readonly snapshot = shallowRef<WindowAppearanceState>();
  readonly state = readonly(this.snapshot);
  private readonly pending = shallowRef(false);
  readonly saving = readonly(this.pending);
  private disposed = false;
  private revision = 0;

  constructor(private readonly provider: PlatformWindowAppearance) {}

  async start(): Promise<void> {
    if (this.disposed) return;
    windowAppearanceSession.value = this;
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.pending.value || windowAppearanceSession.value !== this) return;
    const revision = ++this.revision;
    const state = await this.provider.current();
    if (this.current(revision)) this.snapshot.value = state;
  }
  async save(value: boolean): Promise<WindowAppearanceState | undefined> {
    if (
      this.disposed ||
      this.pending.value ||
      !this.snapshot.value ||
      windowAppearanceSession.value !== this
    )
      return;
    const revision = ++this.revision;
    this.pending.value = true;
    try {
      const state = await this.provider.save(value);
      if (!this.current(revision)) return;
      this.snapshot.value = state;
      return state;
    } finally {
      if (this.current(revision)) this.pending.value = false;
    }
  }
  private current(revision: number): boolean {
    return !this.disposed && this.revision === revision && windowAppearanceSession.value === this;
  }
  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.pending.value = false;
    if (windowAppearanceSession.value === this) windowAppearanceSession.value = undefined;
  }
}
