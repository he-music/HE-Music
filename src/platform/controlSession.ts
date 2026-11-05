export type ControlAction = "play" | "pause" | "toggle" | "next" | "prev";
function isControlAction(value: string): value is ControlAction {
  return ["play", "pause", "toggle", "next", "prev"].includes(value);
}
export interface ControlCommand {
  generation: number;
  requestId: number;
  action: string;
}
export interface ControlProvider {
  start(port: number): Promise<{ generation: number; port: number }>;
  receipt(generation: number, requestId: number, applied: boolean): Promise<void>;
  teardown(generation: number): Promise<void>;
  onCommand(listener: (command: ControlCommand) => void): () => void;
}

/** Receipt means the player action resolved, never that an audio device played. */
export class ControlSession {
  private generation = 0;
  private highWater = 0;
  private disposed = false;
  private starting?: Promise<void>;
  private disposing?: Promise<void>;
  private stop?: () => void;
  private early: Array<{ command: ControlCommand; current: unknown }> = [];
  private tail: Promise<void> = Promise.resolve();
  private pauseRevision = 0;

  constructor(
    private readonly provider: ControlProvider,
    private readonly source: {
      current(): unknown;
      execute(action: ControlAction): Promise<void>;
    },
    private readonly failure: (error: unknown) => void,
  ) {}

  start(port = 0): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.starting) return this.starting;
    this.stop = this.provider.onCommand((command) => {
      if (this.disposed) return;
      if (!this.generation) {
        if (this.early.length < 64)
          this.early.push({ command: { ...command }, current: this.source.current() });
        return;
      }
      this.handle(command);
    });
    this.starting = (async () => {
      const status = await this.provider.start(port);
      if (!Number.isSafeInteger(status.generation) || status.generation <= 0)
        throw new Error("Invalid control generation");
      this.generation = status.generation;
      if (this.disposed) {
        await this.provider.teardown(this.generation);
        return;
      }
      this.early.splice(0).forEach(({ command, current }) => this.handle(command, current));
    })().catch((error: unknown) => {
      this.stop?.();
      this.stop = undefined;
      this.early = [];
      throw error;
    });
    return this.starting;
  }

  private handle(command: ControlCommand, captured = this.source.current()): void {
    if (
      this.disposed ||
      command.generation !== this.generation ||
      !Number.isSafeInteger(command.requestId) ||
      command.requestId <= this.highWater
    )
      return;
    this.highWater = command.requestId;
    const current = captured;
    const generation = this.generation;
    const requestId = command.requestId;
    const action = command.action;
    // Order action invocations, not their completion. pause() is what cancels
    // an outstanding audio play promise, so neither play nor its receipt may
    // hold the invocation queue. The player owns cancellation of late starts.
    this.tail = this.tail
      .then(() => {
        if (this.disposed || generation !== this.generation) return;
        if (current !== this.source.current() || !isControlAction(action)) {
          void this.acknowledge(generation, requestId, false);
          return;
        }
        if (action === "pause") this.pauseRevision++;
        const pauseRevision = this.pauseRevision;
        void (async () => {
          let applied = false;
          try {
            await this.source.execute(action);
            applied = pauseRevision === this.pauseRevision;
          } catch (error) {
            this.failure(error);
          }
          await this.acknowledge(generation, requestId, applied);
        })();
      })
      .catch(this.failure);
  }

  private async acknowledge(
    generation: number,
    requestId: number,
    applied: boolean,
  ): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    try {
      await this.provider.receipt(generation, requestId, applied);
    } catch (error) {
      this.failure(error);
    }
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.stop?.();
    this.stop = undefined;
    this.early = [];
    // Invalidate before awaiting native teardown. Never wait for a player action
    // that could be held by an external backend during shell replacement.
    this.disposing = this.generation
      ? this.provider.teardown(this.generation)
      : (this.starting ?? Promise.resolve());
    return this.disposing;
  }
}
