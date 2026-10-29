export type ProtocolScheme = "orpheus" | "kuwo";
export interface ProtocolIntent {
  epoch: number;
  sequence: number;
  platform: string;
  songId: string;
}
export interface ProtocolResult {
  scheme: string;
  selected: boolean;
  registered: boolean;
  status: string;
  reason?: string;
}
export interface ProtocolStatus {
  epoch: number;
  results: ProtocolResult[];
}
export interface PlatformProtocols {
  begin(): Promise<{ epoch: number }>;
  sync(epoch: number, schemes: string[]): Promise<ProtocolStatus>;
  teardown(epoch: number): Promise<void>;
  onIntent(listener: (intent: ProtocolIntent) => void): () => void;
}

/** Subscribe before Begin; native may emit queued startup intents before Sync resolves. */
export class ProtocolSession {
  private epoch = 0;
  private acknowledged = false;
  private disposed = false;
  private started = false;
  private revision = 0;
  private latest = 0;
  private lastSequence = 0;
  private buffered: ProtocolIntent[] = [];
  private selected = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly stop: () => void;

  constructor(
    private readonly provider: PlatformProtocols,
    private readonly execute: (intent: ProtocolIntent, current: () => boolean) => void,
    private readonly reportFailure: (results?: ProtocolResult[]) => void,
  ) {
    this.stop = provider.onIntent((intent) => {
      if (this.disposed || !this.started) return;
      if (!this.acknowledged) {
        if (this.buffered.length < 16) this.buffered.push(intent);
        return;
      }
      this.consume(intent);
    });
  }

  start(schemes: string[]): Promise<void> {
    if (this.started || this.disposed) return this.queue;
    this.started = true;
    this.queue = this.provider.begin().then((session) => {
      this.epoch = session.epoch;
    });
    return this.sync(schemes);
  }

  sync(schemes: string[]): Promise<void> {
    this.acknowledged = false;
    this.latest++;
    this.buffered = [];
    const revision = ++this.revision;
    const selected = [...schemes];
    this.queue = this.queue
      .then(async () => {
        if (this.disposed || revision !== this.revision || !this.epoch) return;
        const status = await this.provider.sync(this.epoch, selected);
        this.epoch = status.epoch;
        if (this.disposed || revision !== this.revision) return;
        this.selected = new Set(
          status.results
            .filter(
              (result) =>
                selected.includes(result.scheme) &&
                result.selected &&
                result.status === "registered" &&
                result.registered,
            )
            .map((result) => result.scheme),
        );
        if (status.results.some((result) => result.status.endsWith("failed"))) {
          this.reportFailure(status.results.filter((result) => result.status.endsWith("failed")));
        }
        this.acknowledged = true;
        const pending = this.buffered;
        this.buffered = [];
        for (const intent of pending) this.consume(intent);
      })
      .catch(() => {
        this.acknowledged = false;
        this.buffered = [];
        if (!this.disposed) this.reportFailure();
      });
    return this.queue;
  }

  private consume(intent: ProtocolIntent): void {
    const scheme =
      intent.platform === "netease" ? "orpheus" : intent.platform === "kuwo" ? "kuwo" : undefined;
    if (
      !this.acknowledged ||
      this.disposed ||
      intent.epoch !== this.epoch ||
      !Number.isSafeInteger(intent.sequence) ||
      intent.sequence <= this.lastSequence ||
      !scheme ||
      !this.selected.has(scheme) ||
      !/^[1-9]\d{0,15}$/.test(intent.songId) ||
      !Number.isSafeInteger(Number(intent.songId))
    )
      return;
    this.lastSequence = intent.sequence;
    const latest = ++this.latest;
    const revision = this.revision;
    this.execute(
      intent,
      () =>
        !this.disposed && this.acknowledged && revision === this.revision && latest === this.latest,
    );
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.queue;
    this.disposed = true;
    this.acknowledged = false;
    this.revision++;
    this.latest++;
    this.buffered = [];
    this.stop();
    this.queue = this.queue
      .then(async () => {
        if (this.epoch) await this.provider.teardown(this.epoch);
      })
      .catch(() => this.reportFailure());
    return this.queue;
  }
}
