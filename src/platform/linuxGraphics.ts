import { readonly, shallowRef } from "vue";

export interface LinuxGraphicsState {
  enabled: boolean;
  applied: boolean;
  restartRequired: boolean;
  loadFailed: boolean;
}
export interface PlatformLinuxGraphics {
  current(): Promise<LinuxGraphicsState>;
  save(enabled: boolean): Promise<LinuxGraphicsState>;
}

export const linuxGraphicsSession = shallowRef<LinuxGraphicsSession>();

export class LinuxGraphicsSession {
  private readonly snapshot = shallowRef<LinuxGraphicsState>();
  readonly state = readonly(this.snapshot);
  private readonly pending = shallowRef(false);
  readonly saving = readonly(this.pending);
  private disposed = false;
  private revision = 0;

  constructor(private readonly provider: PlatformLinuxGraphics) {}

  async start(): Promise<void> {
    if (this.disposed) return;
    linuxGraphicsSession.value = this;
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.pending.value || linuxGraphicsSession.value !== this) return;
    const revision = ++this.revision;
    const state = await this.provider.current();
    if (this.current(revision)) this.snapshot.value = state;
  }
  async save(enabled: boolean): Promise<LinuxGraphicsState | undefined> {
    if (
      this.disposed ||
      this.pending.value ||
      !this.snapshot.value ||
      linuxGraphicsSession.value !== this
    )
      return;
    const revision = ++this.revision;
    this.pending.value = true;
    try {
      const state = await this.provider.save(enabled);
      if (!this.current(revision)) return;
      this.snapshot.value = state;
      return state;
    } finally {
      if (this.current(revision)) this.pending.value = false;
    }
  }
  private current(revision: number): boolean {
    return !this.disposed && this.revision === revision && linuxGraphicsSession.value === this;
  }
  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.pending.value = false;
    if (linuxGraphicsSession.value === this) linuxGraphicsSession.value = undefined;
  }
}
