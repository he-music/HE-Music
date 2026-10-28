import type { SystemMediaCommand, SystemMediaTrack } from "./mygo.bindings";
import type { PlatformSystemMedia } from "./systemMedia";

// A replaced shell must not clear a newer shell's WebKit metadata or handlers.
const owners = new WeakMap<MediaSession, { release(): void }>();

/** WebKit owns macOS media; native configure/teardown retain the independent power lease. */
export function createWebKitSystemMedia(native: PlatformSystemMedia): PlatformSystemMedia {
  const token = { release: (): void => release() };
  const listeners = new Set<(command: SystemMediaCommand) => void>();
  let generation = 0;
  let revision = 0;
  let enabled = false;
  let session: MediaSession | undefined;
  let track: SystemMediaTrack | undefined;
  let artwork: MediaImage[] = [];
  const handlers = new Set<MediaSessionAction>();
  const owns = () => session !== undefined && owners.get(session) === token;
  const release = () => {
    track = undefined;
    artwork = [];
    const target = session;
    if (target && owns()) {
      const cleanup = (operation: () => void) => {
        try {
          operation();
        } catch {
          // One failing WebKit cleanup must not strand handlers or native power.
        }
      };
      try {
        for (const action of handlers) cleanup(() => target.setActionHandler(action, null));
        cleanup(() => {
          target.metadata = null;
        });
        cleanup(() => {
          target.playbackState = "none";
        });
        cleanup(() => target.setPositionState());
      } finally {
        owners.delete(target);
      }
    }
    handlers.clear();
  };
  const current = (gen: number, rev: number, id: string) => {
    if (!enabled || !owns() || generation !== gen || revision !== rev || track?.id !== id)
      throw new Error("WebKit media snapshot is no longer active");
  };
  const publishMetadata = () => {
    if (!session || !track) return;
    session.metadata = new window.MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork,
    });
  };
  const publishPlayback = () => {
    if (!session || !track) return;
    session.playbackState =
      track.state === "playing" ? "playing" : track.state === "paused" ? "paused" : "none";
    if (track.durationMs > 0) {
      session.setPositionState({
        duration: track.durationMs / 1000,
        position: Math.min(track.positionMs, track.durationMs) / 1000,
        playbackRate: track.rate,
      });
    } else session.setPositionState();
  };
  const validatePlayback = (state: string, positionMs: number) => {
    if (
      !["playing", "paused", "stopped"].includes(state) ||
      !Number.isFinite(positionMs) ||
      positionMs < 0
    )
      throw new Error("Invalid WebKit playback state or position");
  };
  return {
    async configure(gen, requested, preventSleep) {
      enabled = false;
      release();
      const status = await native.configure(gen, false, preventSleep);
      generation = status.generation;
      revision = 0;
      session = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
      enabled = Boolean(
        requested &&
        session &&
        typeof session.setActionHandler === "function" &&
        typeof session.setPositionState === "function" &&
        typeof window.MediaMetadata === "function",
      );
      return { ...status, mediaEnabled: enabled, metadataRequested: false };
    },
    async set(gen, rev, value) {
      if (!enabled || gen !== generation || rev <= revision || rev === 0)
        throw new Error("WebKit media snapshot is no longer active");
      validatePlayback(value.state, value.positionMs);
      if (
        !Number.isFinite(value.rate) ||
        value.rate <= 0 ||
        value.rate > 16 ||
        !Number.isFinite(value.durationMs) ||
        value.durationMs < 0
      )
        throw new Error("Invalid WebKit media rate or duration");
      release();
      revision = rev;
      if (value.source !== "online" || !value.id.trim() || !value.title.trim()) return;
      if (!session) throw new Error("WebKit MediaSession is unavailable");
      owners.get(session)?.release();
      owners.set(session, token);
      track = { ...value };
      const snapshot = track;
      const bind = (action: MediaSessionAction, command: string) => {
        session!.setActionHandler(action, (details) => {
          if (!enabled || !owns() || track !== snapshot || generation !== gen || revision !== rev)
            return;
          const positionMs = command === "seek" ? Number(details.seekTime) * 1000 : 0;
          if (
            !Number.isFinite(positionMs) ||
            positionMs < 0 ||
            (command === "seek" && positionMs > snapshot.durationMs)
          )
            return;
          listeners.forEach((listener) =>
            listener({
              generation: gen,
              revision: rev,
              trackId: snapshot.id,
              action: command,
              positionMs,
            }),
          );
        });
        handlers.add(action);
      };
      try {
        bind("play", "play");
        bind("pause", "pause");
        if (value.canPrevious) bind("previoustrack", "previous");
        if (value.canNext) bind("nexttrack", "next");
        if (value.durationMs > 0) bind("seekto", "seek");
        publishMetadata();
        publishPlayback();
      } catch (error) {
        release();
        throw error;
      }
    },
    async setPlayback(gen, rev, id, state, positionMs) {
      current(gen, rev, id);
      validatePlayback(state, positionMs);
      if (track) {
        track.state = state;
        track.positionMs = positionMs;
        publishPlayback();
      }
    },
    async setArtwork(gen, rev, id, base64) {
      current(gen, rev, id);
      artwork = base64
        ? [{ src: `data:image/${base64.startsWith("iVBOR") ? "png" : "jpeg"};base64,${base64}` }]
        : [];
      publishMetadata();
    },
    async clear(gen, rev) {
      if (gen !== generation || rev <= revision || rev === 0)
        throw new Error("WebKit media snapshot is no longer active");
      revision = rev;
      release();
    },
    async teardown(gen) {
      if (gen !== generation) throw new Error("WebKit media owner is no longer active");
      enabled = false;
      release();
      await native.teardown(gen);
    },
    onCommand(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
