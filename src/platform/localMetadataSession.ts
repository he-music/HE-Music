import { shallowRef } from "vue";
import type { LocalFileRef, MetadataResult, MetadataSaveRequest, Patch } from "./mygo.bindings";

import type { LocalAudioBlockTarget, LocalAudioRelease } from "./localAudioSession";
export type { Info, MetadataResult, MetadataSaveRequest, Patch } from "./mygo.bindings";

export interface LocalMetadataAccess {
  current(): boolean;
  read(): Promise<MetadataResult>;
  save(request: MetadataSaveRequest): Promise<MetadataResult>;
  cancel(operationId: string): Promise<MetadataResult>;
}

export interface LocalMetadataSessionDeps {
  access(ref: LocalFileRef): LocalMetadataAccess | undefined;
  blockAudio(target?: LocalAudioBlockTarget): LocalAudioRelease;
  refreshLibrary(): Promise<void>;
}

export type MetadataRefreshState = "complete" | "failed" | "not_required";
export type MetadataSessionResult = MetadataResult & {
  refresh: MetadataRefreshState;
};

export interface MetadataOperation {
  readonly operationId: string;
  readonly ref: LocalFileRef;
  readonly request: MetadataSaveRequest;
  readonly result: Promise<MetadataSessionResult>;
  readonly completion: Promise<MetadataSessionResult>;
}

const SAVE_DEADLINE_MS = 35_000;
const CANCEL_DEADLINE_MS = 1_000;
const HEX = "0123456789abcdef";

function operationId(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => `${HEX[byte >>> 4]}${HEX[byte & 15]}`).join("");
}

function sameRef(left: LocalFileRef, right: LocalFileRef): boolean {
  return (
    left.grantToken === right.grantToken &&
    left.relativePath === right.relativePath &&
    left.fileId === right.fileId &&
    left.version === right.version
  );
}

function sameRenameScope(result: LocalFileRef, source: LocalFileRef): boolean {
  return (
    result.grantToken === source.grantToken &&
    result.relativePath === source.relativePath &&
    typeof result.fileId === "string" &&
    typeof result.version === "string" &&
    /^[0-9a-f]{64}$/.test(result.fileId) &&
    /^[0-9a-f]{64}$/.test(result.version)
  );
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function pending(operationId: string, code = "pending"): MetadataSessionResult {
  return { code, committed: false, recoveryName: operationId, refresh: "not_required" };
}

function plain(result: MetadataResult, refresh: MetadataRefreshState): MetadataSessionResult {
  return { ...result, refresh };
}

/** Owns metadata writes independently from modal lifetime. Parent shell keeps it alive. */
export class LocalMetadataSession {
  private active?: {
    access: LocalMetadataAccess;
    gateRelease: LocalAudioRelease;
    operation: MetadataOperation;
    fingerprint: string;
    settled: boolean;
    invalidated: boolean;
    gateReleased: boolean;
    reconcileStarted: boolean;
    queryForbidden: boolean;
    resolveCompletion: (result: MetadataSessionResult) => void;
    completion: Promise<MetadataSessionResult>;
  };
  private disposed = false;
  private revision = 0;
  private readonly visibleOperation = shallowRef<MetadataOperation>();

  constructor(private readonly deps: LocalMetadataSessionDeps) {}

  /** Read-only authority check for pending online-match responses. */
  ownsReference(ref: LocalFileRef): boolean {
    if (this.disposed) return false;
    try {
      return this.deps.access(ref)?.current() === true;
    } catch {
      return false;
    }
  }

  async read(ref: LocalFileRef): Promise<MetadataResult | undefined> {
    if (this.disposed) return undefined;
    const revision = this.revision;
    const capturedRef = { ...ref };
    try {
      const access = this.deps.access(capturedRef);
      if (!access || !access.current()) return undefined;
      const result = await access.read();
      if (this.disposed || revision !== this.revision || !access.current()) return undefined;
      if (!result.ref || !sameRef(result.ref, capturedRef))
        return { code: "read_ref_conflict", committed: false };
      return result;
    } catch {
      return { code: "read_failed", committed: false };
    }
  }

  get operation(): MetadataOperation | undefined {
    return this.visibleOperation.value;
  }

  async save(ref: LocalFileRef, sha256: string, patch: Patch): Promise<MetadataSessionResult> {
    if (this.disposed) return pending("", "session_disposed");
    let access: LocalMetadataAccess | undefined;
    try {
      access = this.deps.access(ref);
      if (!access || !access.current()) return pending("", "stale_reference");
    } catch {
      return pending("", "transport_pending");
    }
    const fingerprint = `${stable(ref)}|${sha256}|${stable(patch)}`;
    const existing = this.active;
    if (existing) {
      if (existing.fingerprint === fingerprint) return existing.operation.result;
      return pending(existing.operation.operationId, "metadata_busy");
    }

    const id = operationId();
    let gateRelease: LocalAudioRelease;
    try {
      gateRelease = this.deps.blockAudio({
        grantToken: ref.grantToken,
        relativePath: ref.relativePath,
        fileId: ref.fileId,
      });
    } catch {
      return pending("", "transport_pending");
    }
    const request: MetadataSaveRequest = {
      operationId: id,
      ref: { ...ref },
      sha256,
      patch: {
        Title: patch.Title,
        Artists: patch.Artists === null ? null : [...patch.Artists],
        Album: patch.Album,
        AlbumArtists: patch.AlbumArtists === null ? null : [...patch.AlbumArtists],
        Comment: patch.Comment,
        Lyrics: patch.Lyrics,
        Pictures:
          patch.Pictures === null ? null : patch.Pictures.map((picture) => ({ ...picture })),
      },
    };
    Object.freeze(request.ref);
    if (request.patch.Artists) Object.freeze(request.patch.Artists);
    if (request.patch.AlbumArtists) Object.freeze(request.patch.AlbumArtists);
    if (request.patch.Pictures) {
      request.patch.Pictures.forEach(Object.freeze);
      Object.freeze(request.patch.Pictures);
    }
    Object.freeze(request.patch);
    Object.freeze(request);
    let resolveResult!: (result: MetadataSessionResult) => void;
    let resolveCompletion!: (result: MetadataSessionResult) => void;
    const result = new Promise<MetadataSessionResult>((resolve) => (resolveResult = resolve));
    const completion = new Promise<MetadataSessionResult>(
      (resolve) => (resolveCompletion = resolve),
    );
    const operation: MetadataOperation = {
      operationId: request.operationId,
      ref: request.ref,
      request,
      result,
      completion,
    };
    const active = {
      access,
      gateRelease,
      operation,
      fingerprint,
      settled: false,
      invalidated: false,
      gateReleased: false,
      reconcileStarted: false,
      queryForbidden: false,
      resolveCompletion,
      completion,
    };
    this.active = active;
    this.visibleOperation.value = Object.freeze(operation);
    void this.execute(active, resolveResult);
    return result;
  }

  async reconcile(operationId: string): Promise<MetadataSessionResult | undefined> {
    const active = this.active;
    if (!active || active.operation.operationId !== operationId) return undefined;
    if (active.invalidated || active.queryForbidden) return pending(operationId);
    if (active.settled) return active.completion;
    if (active.reconcileStarted) return this.bounded(active.completion, operationId);
    active.reconcileStarted = true;
    try {
      if (active.gateRelease.ready) await active.gateRelease.ready;
      if (active.invalidated || !this.current(active.access))
        return pending(operationId, "session_invalidated");
      const observed = active.access.save(active.operation.request).then(
        (response) => this.observe(active, response),
        () => pending(operationId, "transport_pending"),
      );
      return await this.bounded(Promise.race([observed, active.completion]), operationId);
    } catch {
      return pending(operationId, "transport_pending");
    } finally {
      active.reconcileStarted = false;
    }
  }

  /** Cancel is only a signal. Its response never clears the save fence. */
  async cancel(
    operationId = this.active?.operation.operationId,
  ): Promise<MetadataResult | undefined> {
    const active = this.active;
    if (!active || !operationId || active.operation.operationId !== operationId || active.settled)
      return undefined;
    active.queryForbidden = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        active.access.cancel(operationId),
        new Promise<MetadataResult>(
          (resolve) =>
            (timer = setTimeout(
              () => resolve({ code: "cancel_pending", committed: false }),
              CANCEL_DEADLINE_MS,
            )),
        ),
      ]);
      active.queryForbidden = response.code !== "ok";
      return response;
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Parent calls this on epoch/grant change; old results remain observable but cannot affect new state. */
  invalidate(): void {
    const active = this.active;
    this.revision++;
    if (!active) return;
    active.invalidated = true;
    this.releaseGate(active);
    if (this.active === active) {
      this.active = undefined;
      this.visibleOperation.value = undefined;
    }
    active.resolveCompletion(pending(active.operation.operationId, "session_invalidated"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    if (active && !active.settled)
      void this.cancel(active.operation.operationId).catch(() => undefined);
    this.invalidate();
  }

  private async execute(
    active: NonNullable<LocalMetadataSession["active"]>,
    resolveResult: (result: MetadataSessionResult) => void,
  ): Promise<void> {
    let native: Promise<MetadataResult>;
    try {
      if (active.gateRelease.ready) {
        try {
          await active.gateRelease.ready;
        } catch {
          resolveResult(
            await this.observe(active, { code: "audio_release_failed", committed: false }),
          );
          return;
        }
      }
      if (active.invalidated || !this.current(active.access)) {
        resolveResult(pending(active.operation.operationId, "session_invalidated"));
        return;
      }
      native = active.access.save(active.operation.request);
    } catch {
      resolveResult(pending(active.operation.operationId, "transport_pending"));
      return;
    }
    const observed = native.then(
      (response) => this.observe(active, response),
      () => pending(active.operation.operationId, "transport_pending"),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<MetadataSessionResult>((resolve) => {
      timer = setTimeout(() => resolve(pending(active.operation.operationId)), SAVE_DEADLINE_MS);
    });
    const result = await Promise.race([observed, timeout, active.completion]);
    if (timer) clearTimeout(timer);
    resolveResult(result);
  }

  private async observe(
    active: NonNullable<LocalMetadataSession["active"]>,
    response: MetadataResult,
  ): Promise<MetadataSessionResult> {
    if (active.invalidated || !this.current(active.access)) {
      active.invalidated = true;
      this.releaseGate(active);
      if (this.active === active) {
        this.active = undefined;
        this.visibleOperation.value = undefined;
      }
      const stale = pending(active.operation.operationId, "session_invalidated");
      active.resolveCompletion(stale);
      return stale;
    }
    if (active.settled) return active.completion;
    const valid = response.committed
      ? !response.ref || sameRenameScope(response.ref, active.operation.ref)
      : true;
    if (!valid) return pending(active.operation.operationId, "save_ref_conflict");
    if (
      !response.committed &&
      ["queued", "pending", "cancelling", "invalid_operation", "transport_pending", "ok"].includes(
        response.code,
      )
    ) {
      if (response.code === "invalid_operation") active.queryForbidden = true;
      return pending(active.operation.operationId, response.code);
    }
    active.settled = true;
    let refresh: MetadataRefreshState = "not_required";
    if (response.committed) {
      try {
        await this.deps.refreshLibrary();
        refresh = "complete";
      } catch {
        refresh = "failed";
      }
    }
    if (active.invalidated) return pending(active.operation.operationId, "session_invalidated");
    const result = plain(response, refresh);
    this.releaseGate(active);
    if (this.active === active) {
      this.active = undefined;
      this.visibleOperation.value = undefined;
    }
    active.resolveCompletion(result);
    return result;
  }

  private async bounded(
    work: Promise<MetadataSessionResult>,
    id: string,
  ): Promise<MetadataSessionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<MetadataSessionResult>((resolve) => {
          timer = setTimeout(() => resolve(pending(id)), SAVE_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private current(access: LocalMetadataAccess): boolean {
    try {
      return access.current();
    } catch {
      return false;
    }
  }

  private releaseGate(active: NonNullable<LocalMetadataSession["active"]>): void {
    if (active.gateReleased) return;
    active.gateReleased = true;
    try {
      active.gateRelease();
    } catch {
      /* A failed release must not orphan the result observer. */
    }
  }
}
