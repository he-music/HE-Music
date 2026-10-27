import { watch } from "vue";
import { loadSystemMediaArtwork } from "./systemMediaArtwork";

interface ArtworkSource {
  settings(): { media: boolean };
  trackID(): string | null;
  artwork?(): string | null;
}

/** Owns one bounded image request; metadata revisions can reuse its completed result. */
export class SystemMediaArtworkSession {
  private request: {
    trackID: string;
    url: string;
    controller: AbortController;
    base64: string | null;
  } | null = null;
  version = 0;
  private stop?: () => void;

  constructor(
    private readonly source: ArtworkSource,
    private readonly changed: () => void,
  ) {}

  start(): void {
    this.stop = watch(
      () => {
        const trackID = this.source.settings().media ? this.source.trackID() : null;
        return trackID ? JSON.stringify([trackID, this.source.artwork?.() || ""]) : "";
      },
      () => this.refresh(),
      { immediate: true, flush: "sync" },
    );
  }

  private refresh(): void {
    this.version++;
    this.request?.controller.abort();
    this.request = null;
    this.changed();
    if (!this.source.settings().media) return;
    const trackID = this.source.trackID();
    const url = trackID ? this.source.artwork?.() : null;
    if (!trackID || !url) return;
    const request: {
      trackID: string;
      url: string;
      controller: AbortController;
      base64: string | null;
    } = { trackID, url, controller: new AbortController(), base64: null };
    this.request = request;
    void loadSystemMediaArtwork(url, request.controller.signal)
      .then((base64) => {
        if (this.request !== request || request.controller.signal.aborted) return;
        request.base64 = base64;
        this.changed();
      })
      .catch(() => {
        // Missing artwork, CORS and decoding failures leave the media session usable.
        if (this.request !== request || request.controller.signal.aborted) return;
        request.base64 = "";
        this.changed();
      });
  }

  snapshot(): { trackID: string; base64: string } | null {
    const request = this.request;
    if (
      !request ||
      request.controller.signal.aborted ||
      request.base64 === null ||
      !this.source.settings().media ||
      request.trackID !== this.source.trackID() ||
      request.url !== this.source.artwork?.()
    )
      return null;
    return { trackID: request.trackID, base64: request.base64 };
  }

  dispose(): void {
    this.version++;
    this.stop?.();
    this.stop = undefined;
    this.request?.controller.abort();
    this.request = null;
  }
}
