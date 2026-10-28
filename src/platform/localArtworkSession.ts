import { admitLocalArtworkImage } from "./localArtworkImage";
import type { LocalFileRef, MetadataResult } from "./mygo.bindings";

export interface LocalArtworkTarget {
  readonly owner: object;
  readonly songID: string;
  readonly platform: string;
  readonly relativePath: string;
  readonly ref: LocalFileRef;
}

export interface LocalArtworkView {
  readonly songID: string;
  readonly platform: string;
  readonly relativePath: string;
  readonly url: string;
}

export interface LocalArtworkSessionDeps {
  read(target: LocalArtworkTarget): Promise<MetadataResult | undefined>;
  current(target: LocalArtworkTarget): boolean;
  createURL(bytes: ArrayBuffer, mime: string): string;
  revokeURL(url: string): void;
  onChange(view: LocalArtworkView | undefined): void;
}

function sameRef(left: LocalFileRef, right: LocalFileRef): boolean {
  return (
    left.grantToken === right.grantToken &&
    left.relativePath === right.relativePath &&
    left.fileId === right.fileId &&
    left.version === right.version
  );
}

function sameTarget(left: LocalArtworkTarget, right: LocalArtworkTarget): boolean {
  return (
    left.owner === right.owner &&
    left.songID === right.songID &&
    left.platform === right.platform &&
    left.relativePath === right.relativePath &&
    sameRef(left.ref, right.ref)
  );
}

/** 独占临时 URL；真实 read 结束前仅保留最新待处理目标，不伪造取消。 */
export class LocalArtworkSession {
  private generation = 0;
  private disposed = false;
  private reading = false;
  private target?: LocalArtworkTarget;
  private pending?: LocalArtworkTarget;
  private accepted?: { target: LocalArtworkTarget; url: string };

  constructor(private readonly deps: LocalArtworkSessionDeps) {}

  update(target: LocalArtworkTarget | undefined): void {
    if (this.disposed) return;
    const captured =
      target &&
      Object.freeze({
        owner: target.owner,
        songID: target.songID,
        platform: target.platform,
        relativePath: target.relativePath,
        ref: Object.freeze({
          grantToken: target.ref.grantToken,
          relativePath: target.ref.relativePath,
          fileId: target.ref.fileId,
          version: target.ref.version,
        }),
      });
    const previous = this.target;
    const previousGeneration = this.generation;
    if (captured && previous && sameTarget(captured, previous)) {
      const live = this.current(captured);
      if (this.disposed || this.generation !== previousGeneration || this.target !== previous)
        return;
      if (live) return;
    }
    const generation = ++this.generation;
    this.target = captured;
    this.pending = captured;
    this.clear();
    if (this.generation !== generation || this.disposed) return;
    if (captured) {
      const live = this.current(captured);
      if (this.disposed || this.generation !== generation || this.target !== captured) return;
      if (!live) {
        this.target = undefined;
        this.pending = undefined;
      }
    }
    this.pump();
  }

  currentURL(songID: string, platform: string, relativePath: string): string | undefined {
    const accepted = this.accepted;
    if (!accepted) return;
    const generation = this.generation;
    const live = this.current(accepted.target);
    if (this.disposed || this.accepted !== accepted || this.generation !== generation) return;
    if (!live) {
      this.update(undefined);
      return;
    }
    const target = accepted.target;
    if (
      target.songID === songID &&
      target.platform === platform &&
      target.relativePath === relativePath
    )
      return accepted.url;
    return undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.target = undefined;
    this.pending = undefined;
    this.clear();
  }

  private current(target: LocalArtworkTarget): boolean {
    try {
      return target.relativePath === target.ref.relativePath && this.deps.current(target);
    } catch {
      return false;
    }
  }

  private valid(target: LocalArtworkTarget, generation: number): boolean {
    return (
      !this.disposed &&
      this.generation === generation &&
      this.target === target &&
      this.current(target) &&
      !this.disposed &&
      this.generation === generation &&
      this.target === target
    );
  }

  private notify(view: LocalArtworkView | undefined): void {
    try {
      this.deps.onChange(view);
    } catch {
      /* 观察者不拥有 URL 生命周期。 */
    }
  }

  private revoke(url: string): void {
    try {
      this.deps.revokeURL(url);
    } catch {
      /* 清理失败不能阻断其他资源清理。 */
    }
  }

  private clear(): void {
    const accepted = this.accepted;
    this.accepted = undefined;
    if (!accepted) return;
    this.revoke(accepted.url);
    // revoke 可重入；不能用旧的清空通知覆盖新 view。
    if (!this.accepted) this.notify(undefined);
  }

  private pump(): void {
    if (this.disposed || this.reading || !this.pending) return;
    const target = this.pending;
    const generation = this.generation;
    this.pending = undefined;
    if (!this.valid(target, generation)) {
      if (this.target === target) this.target = undefined;
      return;
    }
    this.reading = true;
    void this.load(target, generation);
  }

  private async load(target: LocalArtworkTarget, generation: number): Promise<void> {
    try {
      const result = await this.deps.read(target);
      if (
        !this.valid(target, generation) ||
        result?.code !== "ok" ||
        !result.ref ||
        !sameRef(result.ref, target.ref) ||
        result.info?.PicturesLoaded !== true
      )
        return;
      const image = admitLocalArtworkImage(result.info.Pictures);
      if (!image || !this.valid(target, generation)) return;
      const url = this.deps.createURL(image.bytes.buffer, image.mime);
      if (!url.startsWith("blob:")) return;
      if (!this.valid(target, generation)) {
        this.revoke(url);
        return;
      }
      this.accepted = { target, url };
      this.notify(
        Object.freeze({
          songID: target.songID,
          platform: target.platform,
          relativePath: target.relativePath,
          url,
        }),
      );
    } catch {
      // 元数据、图片和 URL 工厂失败均保持无封面，不输出敏感内容。
    } finally {
      this.reading = false;
      if (!this.disposed && this.target === target && this.generation === generation) {
        const live = this.current(target);
        if (!live && !this.disposed && this.target === target && this.generation === generation) {
          this.update(undefined);
        }
      }
      this.pump();
    }
  }
}
