export type TaskbarAction = "previous" | "toggle" | "next";
export interface TaskbarLabels {
  previous: string;
  play: string;
  pause: string;
  next: string;
}
export interface TaskbarSnapshot {
  enabled: boolean;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  labels: TaskbarLabels;
}
export interface TaskbarState extends TaskbarSnapshot {
  epoch: number;
  seq: number;
}
export interface TaskbarCommand {
  epoch: number;
  seq: number;
  action: TaskbarAction;
}
export interface TaskbarFailure {
  epoch: number;
  seq: number;
  code: string;
}
export interface TaskbarProvider {
  begin(): Promise<number>;
  /** Sync acknowledges acceptance; a deferred native failure is reported for its exact state. */
  sync(state: TaskbarState): Promise<void>;
  teardown(epoch: number): Promise<void>;
  onCommand(listener: (command: TaskbarCommand) => void): () => void;
  onFailure?(listener: (failure: TaskbarFailure) => void): () => void;
}

function validSnapshot(snapshot: TaskbarSnapshot): boolean {
  return (
    [snapshot.positionMs, snapshot.durationMs].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    snapshot.positionMs <= snapshot.durationMs &&
    Object.values(snapshot.labels).every(
      (label) => label.length > 0 && [...label].length <= 60 && !/[\p{Cc}]/u.test(label),
    )
  );
}

/** The shell owns one session. No global state or high-frequency reactive dependencies. */
export class TaskbarSession {
  private epoch = 0;
  private seq = 0;
  private acknowledged = 0;
  private disposed = false;
  private token: object | undefined;
  private stop: (() => void) | undefined;
  private stopFailure: (() => void) | undefined;
  private starting: Promise<void> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private pending: TaskbarState | undefined;

  constructor(
    private readonly provider: TaskbarProvider,
    private readonly execute: (action: TaskbarAction) => void,
    private readonly failure: (error: unknown) => void,
  ) {}

  get executionToken(): object | undefined {
    return this.token;
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.starting) return this.starting;
    this.stop = this.provider.onCommand((command) => {
      if (
        this.disposed ||
        !this.token ||
        command.epoch !== this.epoch ||
        command.seq !== this.seq ||
        command.seq !== this.acknowledged ||
        !["previous", "toggle", "next"].includes(command.action)
      )
        return;
      this.execute(command.action);
    });
    this.stopFailure = this.provider.onFailure?.((failure) => {
      if (this.disposed || failure.epoch !== this.epoch || failure.seq !== this.seq) return;
      void this.fail(new Error("Taskbar native application failed"));
    });
    this.starting = (async () => {
      const epoch = await this.provider.begin();
      if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("Invalid taskbar epoch");
      if (this.disposed) {
        await this.provider.teardown(epoch);
        return;
      }
      this.epoch = epoch;
    })().catch((error: unknown) => {
      this.stop?.();
      this.stop = undefined;
      this.stopFailure?.();
      this.stopFailure = undefined;
      if (!this.disposed) this.failure(error);
    });
    return this.starting;
  }

  sync(snapshot: TaskbarSnapshot): Promise<void> {
    if (this.disposed || !this.epoch) return Promise.resolve();
    if (!validSnapshot(snapshot) || this.seq >= Number.MAX_SAFE_INTEGER) {
      this.token = undefined;
      this.failure(new Error("Invalid taskbar snapshot"));
      return this.dispose();
    }
    const state = {
      ...snapshot,
      labels: { ...snapshot.labels },
      epoch: this.epoch,
      seq: ++this.seq,
    };
    this.token = snapshot.enabled ? {} : undefined;
    this.pending = state;
    this.tail = this.tail.then(async () => {
      const next = this.pending;
      this.pending = undefined;
      if (!next || this.disposed) return;
      try {
        await this.provider.sync(next);
        if (!this.disposed && this.seq === next.seq) this.acknowledged = next.seq;
      } catch (error: unknown) {
        if (this.disposed || this.seq !== next.seq) return;
        await this.fail(error);
      }
    });
    return this.tail;
  }
  private async fail(error: unknown): Promise<void> {
    if (this.disposed) return;
    this.token = undefined;
    this.pending = undefined;
    this.disposed = true;
    this.stop?.();
    this.stop = undefined;
    this.stopFailure?.();
    this.stopFailure = undefined;
    try {
      await this.provider.teardown(this.epoch);
    } catch {
      // Native cleanup failure cannot restore an invalid execution token.
    }
    this.failure(error);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return this.tail;
    this.disposed = true;
    this.token = undefined;
    this.pending = undefined;
    this.stop?.();
    this.stop = undefined;
    this.stopFailure?.();
    this.stopFailure = undefined;
    await this.starting;
    await this.tail;
    const epoch = this.epoch;
    this.epoch = 0;
    if (epoch) await this.provider.teardown(epoch);
  }
}
