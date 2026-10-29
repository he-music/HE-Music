import { shallowRef, type ShallowRef } from "vue";
import { admitLocalArtworkImage, type LocalArtworkImage } from "@/platform/localArtworkImage";
import type { LocalFileRef, MetadataResult } from "@/platform/mygo.bindings";

export interface VisibleArtworkTarget {
  readonly entry?: object;
  readonly songID: string;
  readonly platform: string;
  readonly relativePath: string;
  readonly ref: LocalFileRef;
}
export interface VisibleArtworkDeps {
  read(target: VisibleArtworkTarget): Promise<MetadataResult | undefined>;
  isCurrent(target: VisibleArtworkTarget): boolean;
  createURL(bytes: ArrayBuffer, mime: string): string;
  revokeURL(url: string): void;
  maxEntries?: number;
  maxBytes?: number;
}
interface Entry {
  target: VisibleArtworkTarget;
  views: Set<ShallowRef<string | undefined>>;
  image?: LocalArtworkImage;
  url?: string;
  done: boolean;
  loading: boolean;
}
export function visibleArtworkKey(target: VisibleArtworkTarget): string {
  const ref = target.ref;
  return JSON.stringify([
    target.songID,
    target.platform,
    target.relativePath,
    ref.grantToken,
    ref.relativePath,
    ref.fileId,
    ref.version,
  ]);
}

/** Idle cache stores bounded bytes, never blob URLs; active views own URL leases. */
export class VisibleArtworkCache {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  constructor(private readonly deps: VisibleArtworkDeps) {}

  acquire(target: VisibleArtworkTarget) {
    const url = shallowRef<string>();
    if (this.disposed || !this.current(target)) return { url, release: () => {} };
    const captured = Object.freeze({ ...target, ref: Object.freeze({ ...target.ref }) });
    const key = visibleArtworkKey(captured);
    let entry = this.entries.get(key);
    if (entry && !this.current(entry.target)) {
      this.drop(key, entry);
      entry = undefined;
    }
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    } else {
      const limit = this.deps.maxEntries ?? 64;
      if (this.entries.size >= limit) {
        for (const [oldKey, idle] of this.entries) {
          if (!idle.views.size) this.drop(oldKey, idle);
          if (this.entries.size < limit) break;
        }
      }
      if (this.entries.size >= limit) return { url, release: () => {} };
      entry = { target: captured, views: new Set(), done: false, loading: false };
      this.entries.set(key, entry);
    }
    entry.views.add(url);
    if (entry.done) this.publish(entry);
    else if (!entry.loading) {
      entry.loading = true;
      void this.load(key, entry);
    }
    let released = false;
    return {
      url,
      release: () => {
        if (released) return;
        released = true;
        entry.views.delete(url);
        url.value = undefined;
        if (!entry.views.size && entry.url) {
          this.revoke(entry.url);
          entry.url = undefined;
        }
        this.trim();
      },
    };
  }

  /** Called on authorization/entry changes and disabling covers, including idle rows. */
  prune(): void {
    for (const [key, entry] of this.entries) {
      if (!this.current(entry.target)) this.drop(key, entry);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [key, entry] of this.entries) this.drop(key, entry);
  }
  private current(target: VisibleArtworkTarget): boolean {
    try {
      return (
        !this.disposed &&
        target.relativePath === target.ref.relativePath &&
        this.deps.isCurrent(target)
      );
    } catch {
      return false;
    }
  }
  private async load(key: string, entry: Entry): Promise<void> {
    try {
      const result = await this.deps.read(entry.target);
      if (this.entries.get(key) !== entry || !this.current(entry.target)) return;
      const actual = result?.ref;
      const expected = entry.target.ref;
      if (
        result?.code === "ok" &&
        actual &&
        actual.grantToken === expected.grantToken &&
        actual.relativePath === expected.relativePath &&
        actual.fileId === expected.fileId &&
        actual.version === expected.version &&
        result.info?.PicturesLoaded
      ) {
        entry.image = admitLocalArtworkImage(result.info.Pictures);
        this.trim();
        if (this.byteSize() > (this.deps.maxBytes ?? 16 * 1024 * 1024)) entry.image = undefined;
      }
    } catch {
      /* A failed display read is a bounded negative cache entry. */
    } finally {
      if (this.entries.get(key) === entry) {
        entry.done = true;
        if (!this.current(entry.target)) this.drop(key, entry);
        else this.publish(entry);
        this.trim();
      }
    }
  }
  private publish(entry: Entry): void {
    if (!entry.image || !entry.views.size || !this.current(entry.target)) return;
    if (!entry.url) {
      try {
        const url = this.deps.createURL(entry.image.bytes.buffer, entry.image.mime);
        if (!url.startsWith("blob:")) return;
        if (!this.current(entry.target)) {
          this.revoke(url);
          return;
        }
        entry.url = url;
      } catch {
        return;
      }
    }
    for (const view of entry.views) view.value = entry.url;
  }
  private byteSize(): number {
    return [...this.entries.values()].reduce(
      (sum, entry) => sum + (entry.image?.bytes.byteLength ?? 0),
      0,
    );
  }
  private trim(): void {
    let bytes = this.byteSize();
    const limit = this.deps.maxEntries ?? 64;
    const maxBytes = this.deps.maxBytes ?? 16 * 1024 * 1024;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= limit && bytes <= maxBytes) break;
      if (entry.views.size || !entry.done) continue;
      bytes -= entry.image?.bytes.byteLength ?? 0;
      this.drop(key, entry);
    }
  }
  private drop(key: string, entry: Entry): void {
    this.entries.delete(key);
    const url = entry.url;
    entry.url = undefined;
    entry.image = undefined;
    for (const view of entry.views) view.value = undefined;
    entry.views.clear();
    if (url) this.revoke(url);
  }
  private revoke(url: string): void {
    try {
      this.deps.revokeURL(url);
    } catch {
      /* Continue releasing other leases. */
    }
  }
}
