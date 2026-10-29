import type { Info, Picture } from "./mygo.bindings";

export interface MetadataMatchCandidate {
  id: number;
  title: string;
  artists: string[];
  album: string;
  comment: string;
  cover: string;
}
export interface MetadataMatchQuery {
  title: string;
  artist: string;
  album: string;
  duration: number;
  md5: string;
}
export interface MetadataMatchDraft {
  title: string;
  artists: string[];
  album: string;
  comment: string;
  lyrics: string;
  picture?: Picture;
}
export interface MetadataMatchAPI {
  search(query: MetadataMatchQuery): Promise<MetadataMatchCandidate[]>;
  details(candidate: MetadataMatchCandidate, signal: AbortSignal): Promise<MetadataMatchDraft>;
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

  async search(info: Info, md5: string): Promise<MetadataMatchCandidate[] | undefined> {
    if (this.pending || !this.current()) return;
    if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error("Missing native match digest");
    this.cancel();
    const revision = this.revision;
    this.pending = true;
    try {
      const options = await this.api.search({
        title: info.Title,
        artist: info.Artists.join(" / "),
        album: info.Album,
        duration: info.DurationSeconds,
        md5,
      });
      if (revision !== this.revision || !this.current()) return;
      this.options = options.map((item) => ({ ...item, artists: [...item.artists] }));
      return this.options.map((item) => ({ ...item, artists: [...item.artists] }));
    } catch (error) {
      if (revision === this.revision && this.current()) throw error;
      return undefined;
    } finally {
      if (revision === this.revision) this.pending = false;
    }
  }

  async choose(id: number): Promise<MetadataMatchDraft | undefined> {
    if (this.pending || !this.current()) return;
    const candidate = this.options.find((item) => item.id === id);
    if (!candidate) return;
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    this.pending = true;
    try {
      const draft = await this.api.details(candidate, controller.signal);
      if (revision !== this.revision || controller.signal.aborted || !this.current()) return;
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
