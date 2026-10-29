import type { LocalFileRef, MetadataResult } from "@/platform/mygo.bindings";

export type LocalDisplayKind = "artwork" | "lyrics";
export interface LocalDisplayOwner {
  readonly ready: { readonly value: boolean };
  displayAccess?(
    ref: LocalFileRef,
    kind: LocalDisplayKind,
  ):
    | {
        current(): boolean;
        read(): Promise<MetadataResult>;
      }
    | undefined;
}

interface PendingDisplayRead {
  readonly revision: object | undefined;
  readonly promise: Promise<MetadataResult | undefined>;
}
const pending = new WeakMap<LocalDisplayOwner, Map<string, PendingDisplayRead>>();

/** Display-only reads never fall back to the editor's complete-file SHA read. */
export function readLocalDisplay(
  owner: LocalDisplayOwner,
  ref: LocalFileRef,
  kind: LocalDisplayKind,
  revision?: object,
): Promise<MetadataResult | undefined> {
  if (!owner.ready.value) return Promise.resolve(undefined);
  const captured = Object.freeze({ ...ref });
  const access = owner.displayAccess?.(captured, kind);
  if (!access?.current()) return Promise.resolve(undefined);
  const key = JSON.stringify([
    kind,
    captured.grantToken,
    captured.relativePath,
    captured.fileId,
    captured.version,
  ]);
  let jobs = pending.get(owner);
  if (!jobs) {
    jobs = new Map();
    pending.set(owner, jobs);
  }
  const existing = jobs.get(key);
  if (existing && existing.revision === revision) return existing.promise;
  const result = Promise.resolve()
    .then(async () => {
      if (!owner.ready.value || !access.current()) return undefined;
      const value = await access.read();
      if (
        !owner.ready.value ||
        !access.current() ||
        value.code !== "ok" ||
        ownedJobs.get(key)?.promise !== result
      )
        return undefined;
      const actual = value.ref;
      if (
        !actual ||
        actual.grantToken !== captured.grantToken ||
        actual.relativePath !== captured.relativePath ||
        actual.fileId !== captured.fileId ||
        actual.version !== captured.version
      )
        return undefined;
      return value;
    })
    .catch(() => undefined);
  const ownedJobs = jobs;
  jobs.set(key, { revision, promise: result });
  void result.then(() => {
    if (ownedJobs.get(key)?.promise === result) ownedJobs.delete(key);
    if (!ownedJobs.size && pending.get(owner) === ownedJobs) pending.delete(owner);
  });
  return result;
}
