import type { LocalFileRef, MetadataResult } from "./mygo.bindings";

interface MetadataOwner {
  readonly metadata?: { read(ref: LocalFileRef): Promise<MetadataResult | undefined> };
}
const inFlight = new WeakMap<MetadataOwner, Map<string, Promise<MetadataResult | undefined>>>();

/** 歌词与封面只合并同 owner/ref 的挂起读取，不缓存完整图片或已完成结果。 */
export function readLocalMetadata(
  owner: MetadataOwner,
  ref: LocalFileRef,
): Promise<MetadataResult | undefined> {
  const metadata = owner.metadata;
  if (!metadata) return Promise.resolve(undefined);
  const captured = { ...ref };
  const key = JSON.stringify([
    captured.grantToken,
    captured.relativePath,
    captured.fileId,
    captured.version,
  ]);
  let pending = inFlight.get(owner);
  if (!pending) {
    pending = new Map();
    inFlight.set(owner, pending);
  }
  const existing = pending.get(key);
  if (existing) return existing;
  const result = Promise.resolve().then(() => metadata.read(captured));
  pending.set(key, result);
  const jobs = pending;
  const clear = () => {
    if (jobs.get(key) === result) jobs.delete(key);
    if (!jobs.size && inFlight.get(owner) === jobs) inFlight.delete(owner);
  };
  void result.then(clear, clear);
  return result;
}
