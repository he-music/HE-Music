import type { Info, Picture } from "./mygo.bindings";

export interface MetadataMatchIdentity {
  id: string;
  platform: string;
}
export interface MetadataMatchCandidate extends MetadataMatchIdentity {
  title: string;
  artists: string[];
  album: string;
  comment?: string;
  cover: string;
}
export interface MetadataMatchQuery {
  title: string;
  artist: string;
  platform: string;
}
export interface MetadataMatchResources {
  lyrics?: string;
  picture?: Picture;
}
export type MetadataMatchResourceLoader = (
  candidate: MetadataMatchCandidate,
  signal: AbortSignal,
) => Promise<MetadataMatchResources>;
export interface MetadataMatchDraft extends MetadataMatchResources {
  title: string;
  artists?: string[];
  album?: string;
  comment?: string;
}
export interface MetadataMatchAPI {
  search(query: MetadataMatchQuery, signal: AbortSignal): Promise<MetadataMatchCandidate[]>;
}

/** A modal owns this request scope. Replies never write metadata or mutate a form. */
export class LocalMetadataMatch {
  private revision = 0;
  private controller?: AbortController;
  private options: MetadataMatchCandidate[] = [];
  private pending = false;

  constructor(
    private readonly api: MetadataMatchAPI,
    private readonly current: () => boolean,
    private readonly loadResources: MetadataMatchResourceLoader,
  ) {}

  isCurrent(): boolean {
    return this.current();
  }

  get busy(): boolean {
    return this.pending;
  }

  cancel(): void {
    this.revision++;
    this.controller?.abort();
    this.controller = undefined;
    this.options = [];
    this.pending = false;
  }

  async search(info: Info, platform: string): Promise<MetadataMatchCandidate[] | undefined> {
    if (this.pending || !this.current()) return;
    if (!platform || !info.Title.trim()) throw new Error("Missing match platform or title");
    this.cancel();
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    this.pending = true;
    try {
      const options = await this.api.search(
        { title: info.Title, artist: info.Artists.join(" / "), platform },
        controller.signal,
      );
      if (revision !== this.revision || controller.signal.aborted || !this.current()) return;
      this.options = options.map((item) => ({ ...item, artists: [...item.artists] }));
      return this.options.map((item) => ({ ...item, artists: [...item.artists] }));
    } catch (error) {
      if (revision === this.revision && this.current() && !controller.signal.aborted) throw error;
      return undefined;
    } finally {
      if (revision === this.revision) {
        this.pending = false;
        this.controller = undefined;
      }
    }
  }

  async choose(identity: MetadataMatchIdentity): Promise<MetadataMatchDraft | undefined> {
    if (this.pending || !this.current()) return;
    const candidate = this.options.find(
      (item) => item.id === identity.id && item.platform === identity.platform,
    );
    if (!candidate) return;
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    this.pending = true;
    try {
      const resources = await this.loadResources(candidate, controller.signal);
      if (revision !== this.revision || controller.signal.aborted || !this.current()) return;
      const draft: MetadataMatchDraft = { title: candidate.title };
      if (candidate.artists.length) draft.artists = [...candidate.artists];
      if (candidate.album) draft.album = candidate.album;
      if (candidate.comment) draft.comment = candidate.comment;
      if (resources.lyrics !== undefined) draft.lyrics = resources.lyrics;
      if (resources.picture) draft.picture = resources.picture;
      this.options = [];
      return draft;
    } catch (error) {
      if (revision === this.revision && this.current() && !controller.signal.aborted) throw error;
      return undefined;
    } finally {
      if (revision === this.revision) {
        this.pending = false;
        this.controller = undefined;
      }
    }
  }
}
