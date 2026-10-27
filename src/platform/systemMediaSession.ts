import { watch } from "vue";
import type { SystemMediaCommand, SystemMediaTrack } from "./mygo.bindings";
import type { PlatformSystemMedia } from "./systemMedia";
import { SystemMediaArtworkSession } from "./systemMediaArtworkSession";

type Metadata = Omit<SystemMediaTrack, "state" | "positionMs">;
interface SystemMediaSource {
  settings(): { media: boolean; preventSleep: boolean };
  metadata(): Metadata | null;
  artwork?(): string | null;
  state(): "playing" | "paused" | "stopped";
  playback(): { state: "playing" | "paused" | "stopped"; positionMs: number };
  trackID(): string | null;
  onSeek(listener: () => void): () => void;
  execute(command: SystemMediaCommand): void | Promise<void>;
}

/** One Ready shell owns a serialized native session. No clock is a watched dependency. */
export class SystemMediaSession {
  private generation = 0;
  private revision = 0;
  private epoch = 0;
  private active = false;
  private disposed = false;
  private accepted: { revision: number; trackID: string; epoch: number } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stops: Array<() => void> = [];
  private offCommand: () => void;
  private offSeek: () => void;
  private artwork?: SystemMediaArtworkSession;

  constructor(
    private readonly provider: PlatformSystemMedia,
    private readonly source: SystemMediaSource,
    private readonly reportFailure: () => void,
  ) {
    if (provider.setArtwork && source.artwork) {
      this.artwork = new SystemMediaArtworkSession(source, () => this.syncArtwork());
    }
    this.offCommand = provider.onCommand((command) => {
      const accepted = this.accepted;
      if (
        !this.active ||
        this.disposed ||
        !this.source.settings().media ||
        !accepted ||
        command.generation !== this.generation ||
        command.revision !== accepted.revision ||
        command.trackId !== accepted.trackID ||
        command.trackId !== this.source.trackID()
      )
        return;
      void Promise.resolve()
        .then(async () => {
          if (
            this.disposed ||
            this.accepted !== accepted ||
            command.trackId !== this.source.trackID()
          )
            return;
          await this.source.execute(command);
        })
        .catch(this.reportFailure);
    });
    this.offSeek = source.onSeek(() => this.syncPlayback());
  }

  start(): Promise<void> {
    if (this.active || this.disposed) return this.queue;
    this.active = true;
    this.artwork?.start();
    this.stops.push(
      watch(
        () => this.source.settings(),
        () => void this.refresh(true),
        { flush: "sync" },
      ),
      watch(
        () => JSON.stringify(this.source.metadata()),
        () => void this.refresh(false),
        { flush: "sync" },
      ),
      watch(
        () => this.source.state(),
        () => this.syncPlayback(),
        { flush: "sync" },
      ),
    );
    return this.refresh(true);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(operation).catch(this.reportFailure);
    return this.queue;
  }

  private refresh(configure: boolean): Promise<void> {
    const epoch = ++this.epoch;
    this.accepted = null;
    // Config changes must never be skipped: each owns the generation returned by native.
    return this.enqueue(async () => {
      if (this.disposed) return;
      if (configure) {
        const settings = this.source.settings();
        const status = await this.provider.configure(
          this.generation,
          settings.media,
          settings.preventSleep,
        );
        this.generation = status.generation;
        this.revision = 0;
      }
      if (this.disposed || epoch !== this.epoch || !this.source.settings().media) return;
      const revision = ++this.revision;
      const metadata = this.source.metadata();
      if (!metadata || metadata.id !== this.source.trackID()) {
        await this.provider.clear(this.generation, revision);
        return;
      }
      const playback = this.source.playback();
      await this.provider.set(this.generation, revision, { ...metadata, ...playback });
      if (!this.disposed && epoch === this.epoch && metadata.id === this.source.trackID()) {
        this.accepted = { revision, trackID: metadata.id, epoch };
        // A play/pause/seek can happen while Set is in flight.
        this.syncPlayback();
        this.syncArtwork();
      }
    });
  }

  private syncPlayback(): void {
    const accepted = this.accepted;
    if (!this.active || this.disposed || !accepted) return;
    const playback = this.source.playback();
    void this.enqueue(async () => {
      if (this.disposed || this.accepted !== accepted || accepted.trackID !== this.source.trackID())
        return;
      await this.provider.setPlayback(
        this.generation,
        accepted.revision,
        accepted.trackID,
        playback.state,
        playback.positionMs,
      );
    });
  }

  private syncArtwork(): void {
    const accepted = this.accepted;
    const artwork = this.artwork;
    const upload = this.provider.setArtwork?.bind(this.provider);
    if (!accepted || !artwork || !upload || this.disposed) return;
    const version = artwork.version;
    const image = artwork.snapshot();
    const generation = this.generation;
    void this.enqueue(async () => {
      if (
        this.disposed ||
        this.accepted !== accepted ||
        artwork.version !== version ||
        !this.source.settings().media ||
        accepted.trackID !== this.source.trackID()
      )
        return;
      if (image && image.trackID !== accepted.trackID) return;
      // Artwork failure must never interrupt metadata, playback or subsequent mutations.
      await upload(generation, accepted.revision, accepted.trackID, image?.base64 ?? "").catch(
        () => {},
      );
    });
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.queue;
    this.disposed = true;
    this.active = false;
    this.accepted = null;
    this.artwork?.dispose();
    this.epoch++;
    this.stops.splice(0).forEach((stop) => stop());
    this.offSeek();
    return this.enqueue(async () => {
      try {
        if (this.generation !== 0) await this.provider.teardown(this.generation);
      } finally {
        this.offCommand();
      }
    });
  }
}
