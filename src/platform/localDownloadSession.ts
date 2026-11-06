import { computed, shallowRef } from "vue";
import { audioOutputFormat } from "./audioSource";
import { copyDownloadIssues, validDownloadIssues } from "./localDownloadDiagnostics";
import type {
  DownloadIssue,
  DownloadMetadata,
  DownloadOperation,
  DownloadOptions,
  DownloadRequest,
  DownloadState,
  ScanEntry,
} from "@/platform/mygo.bindings";
export type { DownloadMetadata, DownloadOptions } from "@/platform/mygo.bindings";
import {
  localDownloadSnapshot,
  validLocalDownloadFormat,
  type LocalDownloadPersistence,
  type LocalDownloadSnapshot,
} from "./localDownloadPersistence";

export interface LocalDownloadAccess {
  current(): boolean;
  start(request: DownloadRequest): Promise<DownloadOperation>;
  read(id: string): Promise<DownloadState>;
  cancel(id: string): Promise<DownloadState>;
  forget?(id: string): Promise<boolean>;
}
export interface LocalDownloadSource {
  readonly id: string;
  readonly platform: string;
  readonly name: string;
  readonly links: readonly {
    readonly name: string;
    readonly quality: number;
    readonly format: string;
    readonly size: string;
  }[];
}
export type LocalDownloadResolver = (
  quality: string,
  source: LocalDownloadSource,
  options?: DownloadOptions,
  resolveOptions?: DownloadResolveOptions,
) => Promise<{ url: string; format: string; metadata?: DownloadMetadata }>;

/** Copy only resolver inputs; link URLs and song credentials never become retry data. */
export function localDownloadSource(source: LocalDownloadSource): LocalDownloadSource {
  return Object.freeze({
    id: source.id,
    platform: source.platform,
    name: source.name,
    links: Object.freeze(
      source.links
        .filter((link) => validLocalDownloadFormat(audioOutputFormat(source.platform, link.format)))
        .map(({ name, quality, format, size }) => Object.freeze({ name, quality, format, size })),
    ),
  });
}
export interface DownloadResolveOptions {
  readonly writeLyricTranslation: boolean;
  readonly writeLyricRomaji: boolean;
}

export interface LocalDownloadDisplay {
  readonly artists: string;
  readonly album: string;
  readonly cover: string;
  readonly duration: number;
}

export interface LocalDownloadInput {
  grantToken: string;
  filename: string;
  url: string;
  label: string;
  quality: string;
  source: LocalDownloadSource;
  resolveURL: LocalDownloadResolver;
  options?: DownloadOptions;
  resolveOptions?: DownloadResolveOptions;
  display?: LocalDownloadDisplay;
}
export type DownloadWarningCode =
  | "io_error"
  | "invalid_request"
  | "network_error"
  | "http_rejected"
  | "limit"
  | "payload_rejected"
  | "unsupported"
  | "atomic_commit_failed"
  | "durability_uncertain"
  | "partial_committed"
  | "sync_failed"
  | "cleanup_failed"
  | "registration_failed"
  | "conflict"
  | "cancelled"
  | "timeout"
  | "revoked";

export interface LocalDownloadTask {
  readonly id: string;
  readonly filename: string;
  readonly label: string;
  readonly quality: string;
  readonly song?: { readonly id: string; readonly platform: string };
  readonly display?: LocalDownloadDisplay;
  readonly createdAt?: number;
  readonly completedAt?: number;
  readonly target?: { readonly directory: string; readonly relativePath: string };
  readonly phase: "active" | "unknown" | "success" | "failed" | "saved";
  readonly done: boolean;
  readonly committed: boolean;
  readonly received: number;
  readonly total: number;
  readonly percent: number | undefined;
  readonly refresh: "none" | "pending" | "complete" | "failed";
  readonly retryable: boolean;
  readonly interrupted?: boolean;
  readonly warning?: DownloadWarningCode;
  readonly issues?: readonly DownloadIssue[];
  readonly residualName?: string;
}
interface RecordState {
  task: LocalDownloadTask;
  token: string;
  access: LocalDownloadAccess;
  file?: ScanEntry;
  sequence: number;
  pending: Set<() => void>;
  filePending: Set<() => void>;
  retrying: boolean;
  retiring?: boolean;
  recipe?: {
    quality: string;
    source: LocalDownloadSource;
    resolveURL: LocalDownloadResolver;
    options?: DownloadOptions;
    resolveOptions?: DownloadResolveOptions;
  };
  targetDirectory: string;
  options?: DownloadOptions;
  resolveOptions?: DownloadResolveOptions;
  removal?: {
    promise: Promise<boolean>;
    resolve(value: boolean): void;
    timer: ReturnType<typeof setTimeout>;
    finishing: boolean;
    acknowledged: boolean;
  };
  timer?: ReturnType<typeof setTimeout>;
}
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function validDownloadHTTPURL(value: string): boolean {
  if (
    !isWellFormedUnicode(value) ||
    new TextEncoder().encode(value).length > 8192 ||
    value !== value.trim()
  )
    return false;
  if (
    !/^https?:\/\/[^/\\?#]+/i.test(value) ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  )
    return false;
  const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  if (
    !authority ||
    authority.includes("@") ||
    authority.includes("%") ||
    value.includes("\\") ||
    /%(?![0-9a-f]{2})/i.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !!url.hostname &&
      !!url.host &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validDownloadRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 240 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !value.includes(String.fromCharCode(0)) &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}

export function validDownloadOptions(options: DownloadOptions | undefined): boolean {
  if (!options) return true;
  if (
    options.relativeDirectory !== undefined &&
    options.relativeDirectory !== "" &&
    !validDownloadRelativePath(options.relativeDirectory)
  )
    return false;
  if (
    !options.writeMetadata &&
    !options.writeCover &&
    !options.writeLyrics &&
    !options.saveSidecars
  )
    return true;
  const metadata = options.metadata;
  if (
    !metadata ||
    !isWellFormedUnicode(metadata.title) ||
    !isWellFormedUnicode(metadata.album) ||
    !isWellFormedUnicode(metadata.lyrics) ||
    metadata.artists.length > 64
  )
    return false;
  const encoder = new TextEncoder();
  if (
    encoder.encode(metadata.title).length > 4096 ||
    encoder.encode(metadata.album).length > 4096 ||
    encoder.encode(metadata.lyrics).length > 1 << 20 ||
    metadata.artists.some(
      (artist) => !isWellFormedUnicode(artist) || encoder.encode(artist).length > 4096,
    )
  )
    return false;
  const coverBytes = metadata.coverURL ? encoder.encode(metadata.coverURL).length : 0;
  if (coverBytes > 8192) return false;
  const total =
    encoder.encode(metadata.title).length +
    encoder.encode(metadata.album).length +
    encoder.encode(metadata.lyrics).length +
    coverBytes +
    metadata.artists.reduce((sum, artist) => sum + encoder.encode(artist).length, 0);
  return (
    total <= 2 << 20 &&
    (!options.writeCover || !metadata.coverURL || validDownloadHTTPURL(metadata.coverURL))
  );
}

export function validDownloadFilename(name: string): boolean {
  return (
    isWellFormedUnicode(name) &&
    new TextEncoder().encode(name).length <= 240 &&
    name.trim() === name &&
    !name.startsWith(".") &&
    !/[\\/:<>"|?*\p{Cc}]/u.test(name) &&
    !/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:[ .]|$)/i.test(name) &&
    validLocalDownloadFormat(name.slice(name.lastIndexOf(".") + 1)) &&
    name.includes(".")
  );
}
/** Owned by FilesSession; closing a view must not dispose this queue. */
export class LocalDownloadSession {
  private readonly list = shallowRef<readonly LocalDownloadTask[]>([]);
  readonly tasks = computed(() => this.list.value);
  readonly persistenceError = shallowRef<string>();
  readonly restored: Promise<void>;
  private readonly records = new Map<string, RecordState>();
  private readonly archived = new Map<string, LocalDownloadSnapshot>();
  private readonly archivedRetrying = new Set<string>();
  private readonly touched = new Set<string>();
  private loaded = false;
  private writes: Promise<void> = Promise.resolve();
  private disposed = false;
  private beginRestore?: () => void;
  private readonly archivedRows = new WeakMap<LocalDownloadSnapshot, LocalDownloadTask>();
  constructor(
    private readonly deps: {
      access(token: string): LocalDownloadAccess | undefined;
      onCommitted(token: string, file?: ScanEntry): Promise<void>;
      persistence?: LocalDownloadPersistence;
      deferRestore?: boolean;
      directoryPath?(token: string): string | undefined;
      directoryToken?(path: string): string | undefined;
      resolveURL?: LocalDownloadResolver;
    },
  ) {
    if (deps.deferRestore) {
      this.restored = new Promise<void>((resolve) => {
        this.beginRestore = () => {
          void this.restore().then(resolve);
        };
      });
    } else this.restored = this.restore();
  }

  restoreHistory(): Promise<void> {
    const start = this.beginRestore;
    this.beginRestore = undefined;
    start?.();
    return this.restored;
  }
  private async restore(): Promise<void> {
    if (this.disposed) return;
    if (!this.deps.persistence) {
      this.loaded = true;
      return;
    }
    try {
      // Validate all rows before merging any of them. Corrupt data is never partially cleared.
      const snapshots = (await this.deps.persistence.load()).map(localDownloadSnapshot);
      if (new Set(snapshots.map((item) => item.id)).size !== snapshots.length)
        throw new Error("Invalid history");
      if (this.disposed) return;
      for (const snapshot of snapshots) {
        if (this.records.has(snapshot.id) || this.touched.has(snapshot.id)) continue;
        this.archived.set(snapshot.id, snapshot);
      }
      this.loaded = true;
      this.publish();
    } catch {
      if (!this.disposed) this.persistenceError.value = "mygo.downloads.loadFailed";
    }
  }

  private archivedTask(snapshot: LocalDownloadSnapshot): LocalDownloadTask {
    const cached = this.archivedRows.get(snapshot);
    if (cached) return cached;
    const interrupted = !snapshot.done;
    const task: LocalDownloadTask = {
      id: snapshot.id,
      filename: snapshot.filename,
      label: snapshot.label,
      quality: snapshot.quality,
      ...(snapshot.source
        ? { song: Object.freeze({ id: snapshot.source.id, platform: snapshot.source.platform }) }
        : {}),
      ...(snapshot.targetDirectory
        ? {
            target: {
              directory: snapshot.targetDirectory,
              relativePath: this.relativePath(snapshot.filename, snapshot.options),
            },
          }
        : {}),
      ...(snapshot.display || snapshot.options?.metadata
        ? {
            display: {
              artists:
                snapshot.display?.artists ?? snapshot.options?.metadata?.artists.join(" / ") ?? "",
              album: snapshot.display?.album ?? snapshot.options?.metadata?.album ?? "",
              cover: "/images/song.jpg?asset",
              duration: snapshot.display?.duration ?? 0,
            },
          }
        : {}),
      ...(snapshot.createdAt !== undefined ? { createdAt: snapshot.createdAt } : {}),
      ...(snapshot.completedAt !== undefined ? { completedAt: snapshot.completedAt } : {}),
      phase: interrupted ? "failed" : snapshot.phase,
      done: true,
      committed: snapshot.committed,
      received: snapshot.received,
      total: snapshot.total,
      percent:
        snapshot.phase === "success"
          ? 100
          : snapshot.total
            ? Math.min(99, Math.floor((snapshot.received / snapshot.total) * 100))
            : undefined,
      refresh: "none",
      interrupted,
      ...(snapshot.warning ? { warning: snapshot.warning } : {}),
      ...(snapshot.issues ? { issues: copyDownloadIssues(snapshot.issues) } : {}),
      ...(snapshot.residualName ? { residualName: snapshot.residualName } : {}),
      retryable:
        !snapshot.committed &&
        snapshot.warning !== "cleanup_failed" &&
        !!snapshot.source &&
        !!snapshot.targetDirectory &&
        !!this.deps.directoryToken &&
        !!this.deps.resolveURL,
    };
    this.archivedRows.set(snapshot, task);
    return task;
  }

  /** Release native operation slots while retaining independent durable task records. */
  private async archiveFinished(): Promise<void> {
    for (const record of this.records.values()) {
      const forget = record.access.forget;
      if (
        !this.current(record) ||
        !record.task.done ||
        record.pending.size ||
        record.retrying ||
        record.retiring ||
        record.removal ||
        !forget
      )
        continue;
      record.retiring = true;
      try {
        const snapshot = localDownloadSnapshot({
          ...record.task,
          source: record.recipe?.source,
          targetDirectory: record.targetDirectory,
          options: record.options,
          resolveOptions: record.resolveOptions,
        });
        if (!(await this.bounded(() => forget(record.task.id), record)) || !this.current(record))
          continue;
        for (const stop of [...record.filePending]) stop();
        this.records.delete(record.task.id);
        this.archived.set(record.task.id, snapshot);
        clearTimeout(record.timer);
        record.recipe = undefined;
        record.token = "";
        this.publish();
      } catch {
        // A rejected/unknown native cleanup retains its record and can be retried.
      } finally {
        record.retiring = false;
      }
    }
  }

  async start(input: LocalDownloadInput): Promise<string | undefined> {
    if (this.deps.persistence && this.deps.resolveURL && !this.disposed)
      await this.archiveFinished();
    if (
      this.disposed ||
      [...this.records.values()].some(
        (record) =>
          record.token === input.grantToken &&
          record.task.filename.normalize("NFC").toLowerCase() ===
            input.filename.normalize("NFC").toLowerCase() &&
          (!record.task.done || record.task.committed),
      ) ||
      [...this.records.values()].filter((record) => !record.task.done).length >= 2 ||
      !validDownloadFilename(input.filename) ||
      !validDownloadHTTPURL(input.url) ||
      !validDownloadOptions(input.options)
    )
      return undefined;
    const access = this.deps.access(input.grantToken);
    if (!access?.current()) return undefined;
    const id = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const targetDirectory = this.deps.directoryPath?.(input.grantToken) ?? "";
    const record: RecordState = {
      task: {
        id,
        filename: input.filename,
        label: input.label,
        quality: input.quality,
        createdAt: Date.now(),
        song: Object.freeze({ id: input.source.id, platform: input.source.platform }),
        ...(input.display
          ? {
              display: Object.freeze({
                artists: input.display.artists,
                album: input.display.album,
                cover: input.display.cover,
                duration: input.display.duration,
              }),
            }
          : {}),
        ...(targetDirectory
          ? {
              target: Object.freeze({
                directory: targetDirectory,
                relativePath: this.relativePath(input.filename, input.options),
              }),
            }
          : {}),
        phase: "active",
        done: false,
        committed: false,
        received: 0,
        total: 0,
        percent: undefined,
        refresh: "none",
        retryable: false,
      },
      token: input.grantToken,
      access,
      sequence: 0,
      pending: new Set(),
      filePending: new Set(),
      retrying: false,
      recipe: {
        quality: input.quality,
        source: localDownloadSource(input.source),
        resolveURL: input.resolveURL,
        options: input.options,
        resolveOptions: input.resolveOptions,
      },
      targetDirectory,
      options: input.options,
      resolveOptions: input.resolveOptions,
    };
    this.records.set(id, record);
    this.touched.add(id);
    this.publish();
    try {
      const result = await this.bounded(
        () =>
          (() => {
            const request = {
              operationId: id,
              grantToken: input.grantToken,
              filename: input.filename,
              url: input.url,
              ...(input.options ? { options: input.options } : {}),
            };
            return access.start(request);
          })(),
        record,
      );
      if (this.current(record) && result.operationId !== id) this.unknown(record);
    } catch {
      if (this.current(record)) this.unknown(record);
    }
    // Lost Start responses are recovered only by reads of the original id.
    if (this.current(record)) this.schedule(record);
    this.continueRemoval(record);
    return id;
  }

  private async retryArchived(id: string): Promise<string | undefined> {
    const snapshot = this.archived.get(id);
    const resolveURL = this.deps.resolveURL;
    if (
      !snapshot ||
      !this.archivedTask(snapshot).retryable ||
      !snapshot.source ||
      !resolveURL ||
      this.archivedRetrying.has(id) ||
      this.disposed
    )
      return;
    const token = this.deps.directoryToken?.(snapshot.targetDirectory);
    const access = token ? this.deps.access(token) : undefined;
    if (!token || !access?.current()) return;
    this.archivedRetrying.add(id);
    const source = localDownloadSource({
      ...snapshot.source,
      links: snapshot.source.links.map((link) => ({ ...link, size: "" })),
    });
    try {
      const result = await this.bounded(() =>
        snapshot.options || snapshot.resolveOptions
          ? resolveURL(snapshot.quality, source, snapshot.options, snapshot.resolveOptions)
          : resolveURL(snapshot.quality, source),
      );
      if (
        this.disposed ||
        this.archived.get(id) !== snapshot ||
        !access.current() ||
        this.deps.directoryToken?.(snapshot.targetDirectory) !== token ||
        !this.validResolvedFormat(snapshot.filename, snapshot.quality, source, result.format)
      )
        return;
      const replacement = await this.start({
        grantToken: token,
        filename: snapshot.filename,
        label: snapshot.label,
        quality: snapshot.quality,
        display: this.archivedTask(snapshot).display,
        source,
        resolveURL,
        url: result.url,
        options: this.withResolvedMetadata(snapshot.options, result.metadata),
        resolveOptions: snapshot.resolveOptions,
      });
      if (replacement && this.archived.get(id) === snapshot) {
        this.archived.delete(id);
        this.touched.add(id);
        this.publish();
      }
      return replacement;
    } catch {
      return undefined;
    } finally {
      this.archivedRetrying.delete(id);
    }
  }

  private validResolvedFormat(
    filename: string,
    quality: string,
    source: LocalDownloadSource,
    resolved: string,
  ): boolean {
    const format = resolved.toLowerCase();
    const link = source.links.find((item) => item.name === quality);
    return (
      !!link &&
      validLocalDownloadFormat(format) &&
      format === audioOutputFormat(source.platform, link.format) &&
      filename.toLowerCase().endsWith(`.${format}`)
    );
  }

  async retry(id: string): Promise<string | undefined> {
    if (this.archived.has(id)) return this.retryArchived(id);
    const record = this.records.get(id);
    const recipe = record?.recipe;
    if (
      !record ||
      !recipe ||
      !this.current(record) ||
      !record.task.retryable ||
      record.retrying ||
      record.retiring ||
      record.removal
    )
      return undefined;
    record.retrying = true;
    let replacement: string | undefined;
    try {
      const result = await this.bounded(
        () =>
          recipe.options || recipe.resolveOptions
            ? recipe.resolveURL(
                recipe.quality,
                recipe.source,
                recipe.options,
                recipe.resolveOptions,
              )
            : recipe.resolveURL(recipe.quality, recipe.source),
        record,
      );
      if (
        !this.current(record) ||
        record.recipe !== recipe ||
        !record.task.retryable ||
        !this.validResolvedFormat(
          record.task.filename,
          recipe.quality,
          recipe.source,
          result.format,
        )
      )
        return undefined;
      replacement = await this.start({
        grantToken: record.token,
        filename: record.task.filename,
        label: record.task.label,
        quality: recipe.quality,
        display: record.task.display,
        source: recipe.source,
        resolveURL: recipe.resolveURL,
        options: this.withResolvedMetadata(recipe.options, result.metadata),
        resolveOptions: recipe.resolveOptions,
        url: result.url,
      });
      return replacement;
    } catch {
      return undefined;
    } finally {
      record.retrying = false;
      if (replacement && this.current(record)) await this.retire(id);
    }
  }

  /** Remove the task only after cancellation and native cleanup are confirmed. */
  remove(id: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.archived.has(id)) return this.retire(id);
    const record = this.records.get(id);
    if (!record || !this.current(record)) return Promise.resolve(false);
    if (record.removal) return record.removal.promise;
    if (record.retrying || record.retiring) return Promise.resolve(false);
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    record.removal = {
      promise,
      resolve,
      timer: setTimeout(() => this.finishRemoval(record, false), 10_000),
      finishing: false,
      acknowledged: record.task.done,
    };
    if (record.task.done) this.continueRemoval(record);
    else void this.cancel(id);
    return promise;
  }

  private finishRemoval(record: RecordState, result: boolean): void {
    const removal = record.removal;
    if (!removal) return;
    record.removal = undefined;
    clearTimeout(removal.timer);
    removal.resolve(result);
  }

  private continueRemoval(record: RecordState): void {
    const removal = record.removal;
    if (
      !removal ||
      removal.finishing ||
      !this.current(record) ||
      !record.task.done ||
      record.pending.size > 0 ||
      record.retrying ||
      record.retiring
    )
      return;
    if (
      !removal.acknowledged &&
      (record.task.residualName ||
        record.task.refresh === "failed" ||
        [
          "cleanup_failed",
          "registration_failed",
          "sync_failed",
          "partial_committed",
          "durability_uncertain",
        ].includes(record.task.warning ?? ""))
    ) {
      this.finishRemoval(record, false);
      return;
    }
    removal.finishing = true;
    void this.retire(record.task.id).then((result) => this.finishRemoval(record, result));
  }

  async retire(id: string): Promise<boolean> {
    if (this.disposed) return false;
    if (this.archived.has(id)) {
      if (this.archivedRetrying.has(id)) return false;
      this.archived.delete(id);
      this.touched.add(id);
      this.publish();
      return true;
    }
    const record = this.records.get(id);
    const forget = record?.access.forget;
    if (
      !record ||
      !this.current(record) ||
      !record.task.done ||
      record.pending.size > 0 ||
      record.retrying ||
      record.retiring ||
      !forget
    )
      return false;
    record.retiring = true;
    try {
      const forgotten = await this.bounded(() => forget(id), record);
      if (!forgotten || !this.current(record)) return false;
      for (const stop of [...record.filePending]) stop();
      this.records.delete(id);
      this.touched.add(id);
      clearTimeout(record.timer);
      record.recipe = undefined;
      record.token = "";
      this.publish();
      this.finishRemoval(record, true);
      return true;
    } catch {
      return false;
    } finally {
      record.retiring = false;
    }
  }
  async refresh(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || !this.current(record) || (record.task.done && !record.task.committed)) return;
    if (record.task.done) {
      if (record.task.refresh === "failed") await this.refreshCommitted(record);
      return;
    }
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    await this.query(record, "read");
  }

  async cancel(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || !this.current(record) || record.task.done) return;
    await this.query(record, "cancel");
  }

  /** Retire one revoked grant, or all records before replacing the epoch. */
  invalidate(token?: string): void {
    for (const record of this.records.values()) {
      if (token !== undefined && record.token !== token) continue;
      this.finishRemoval(record, false);
      if (this.deps.persistence) {
        try {
          this.archived.set(
            record.task.id,
            localDownloadSnapshot({
              ...record.task,
              source: record.recipe?.source,
              targetDirectory: record.targetDirectory,
              options: record.recipe?.options,
              resolveOptions: record.recipe?.resolveOptions,
            }),
          );
        } catch {
          // Cleanup must finish even when a malformed live record cannot be archived.
          // Preserve the existing disk history until a fresh session can reload it.
          this.loaded = false;
          this.persistenceError.value = "mygo.downloads.saveFailed";
        }
      }
      this.records.delete(record.task.id);
      this.touched.add(record.task.id);
      for (const stop of [...record.pending, ...record.filePending]) stop();
      clearTimeout(record.timer);
      if (!record.task.done) {
        const access = record.access;
        const id = record.task.id;
        // Detached cleanup has its own deadline and cannot mutate any record.
        void this.bounded(() => access.cancel(id)).catch(() => {});
      }
      record.recipe = undefined;
      record.token = "";
    }
    this.publish();
  }
  dispose(): Promise<void> {
    // The last published snapshot survives shutdown; clearing live grants must not erase it.
    this.disposed = true;
    this.invalidate();
    return this.restoreHistory().then(() => this.writes);
  }
  private current(record: RecordState): boolean {
    return !this.disposed && this.records.get(record.task.id) === record && record.access.current();
  }
  private publish(): void {
    this.list.value = [
      ...[...this.records.values()].map((record) => record.task),
      ...[...this.archived.values()].map((snapshot) => this.archivedTask(snapshot)),
    ];
    if (!this.loaded || this.disposed || !this.deps.persistence) return;
    try {
      const snapshots = [
        ...[...this.records.values()].map((record) =>
          localDownloadSnapshot({
            ...record.task,
            source: record.recipe?.source,
            targetDirectory: record.targetDirectory,
            options: record.recipe?.options,
            resolveOptions: record.recipe?.resolveOptions,
          }),
        ),
        ...[...this.archived.values()].map(localDownloadSnapshot),
      ];
      const persistence = this.deps.persistence;
      this.writes = this.writes
        .catch(() => {})
        .then(async () => {
          try {
            await persistence.save(snapshots);
            this.persistenceError.value = undefined;
          } catch {
            this.persistenceError.value = "mygo.downloads.saveFailed";
          }
        });
    } catch {
      this.persistenceError.value = "mygo.downloads.saveFailed";
    }
  }
  private unknown(record: RecordState): void {
    if (record.task.done) return;
    record.task = { ...record.task, phase: "unknown" };
    this.publish();
  }
  private bounded<T>(
    run: () => Promise<T>,
    record?: RecordState,
    timeout = 3000,
    file = false,
  ): Promise<T> {
    const pending = file ? record?.filePending : record?.pending;
    return new Promise((resolve, reject) => {
      let active = true;
      const stop = () => {
        active = false;
        clearTimeout(timer);
        pending?.delete(stop);
        reject(new Error("Unavailable"));
      };
      const timer = setTimeout(stop, timeout);
      pending?.add(stop);
      Promise.resolve()
        .then(() => {
          if (!active) throw new Error("Unavailable");
          return run();
        })
        .then((value) => {
          clearTimeout(timer);
          pending?.delete(stop);
          resolve(value);
        }, stop);
    });
  }
  private schedule(record: RecordState): void {
    if (!this.current(record) || record.task.done || record.timer) return;
    record.timer = setTimeout(() => {
      record.timer = undefined;
      void this.query(record, "read");
    }, 250);
  }
  private async query(record: RecordState, method: "read" | "cancel"): Promise<void> {
    const sequence = ++record.sequence;
    try {
      const state = await this.bounded(() => record.access[method](record.task.id), record);
      if (!this.current(record) || record.task.done || sequence !== record.sequence) return;
      if (!this.validState(record, state)) {
        this.unknown(record);
        return;
      }
      const saved = this.isSavedOutcome(state);
      const warning = state.code === "ok" ? undefined : this.warningCode(state.code);
      record.task = {
        ...record.task,
        done: state.done,
        committed: state.committed,
        ...(state.done ? { completedAt: Date.now() } : {}),
        received: state.received,
        total: state.total,
        percent: saved
          ? 100
          : state.total
            ? Math.min(99, Math.floor((state.received / state.total) * 100))
            : undefined,
        phase: saved
          ? state.code === "ok"
            ? "success"
            : "saved"
          : state.done
            ? state.committed
              ? "saved"
              : "failed"
            : "active",
        retryable: this.isRetryable(state),
        ...(warning ? { warning } : {}),
        ...(state.issues?.length ? { issues: copyDownloadIssues(state.issues) } : {}),
        ...(state.residualName ? { residualName: state.residualName } : {}),
      };
      if (state.done && state.committed && state.ref) {
        const metadata = record.options?.metadata;
        record.file = {
          ref: { ...state.ref },
          relativePath: state.ref.relativePath,
          filename: record.task.filename,
          size: state.received,
          metadata: {
            Title: metadata?.title || record.task.label,
            Artists: metadata?.artists
              ? [...metadata.artists]
              : record.task.display?.artists
                ? [record.task.display.artists]
                : [],
            Album: metadata?.album || record.task.display?.album || "",
            DurationSeconds: record.task.display?.duration ?? 0,
            Container: "",
            AlbumArtists: [],
            Comment: "",
            Lyrics: "",
            Pictures: [],
            PicturesLoaded: false,
            BitrateKbps: 0,
            SampleRateHz: 0,
            Channels: 0,
            BitsPerSample: 0,
            Codec: "",
          },
        };
      }
      if (state.done && state.committed) void this.refreshCommitted(record);
      if (this.current(record)) this.publish();
    } catch {
      if (this.current(record) && !record.task.done && sequence === record.sequence)
        this.unknown(record);
    } finally {
      if (this.current(record)) this.schedule(record);
      this.continueRemoval(record);
    }
  }
  private async refreshCommitted(record: RecordState): Promise<void> {
    if (!this.current(record) || !record.task.committed || record.task.refresh === "pending")
      return;
    record.task = { ...record.task, refresh: "pending" };
    this.publish();
    try {
      // Index the saved directory without starting another transfer.
      await this.bounded(
        () => this.deps.onCommitted(record.token, record.file),
        record,
        300_000,
        true,
      );
      if (this.current(record)) record.task = { ...record.task, refresh: "complete" };
    } catch {
      if (this.current(record)) record.task = { ...record.task, refresh: "failed" };
    } finally {
      if (this.current(record)) this.publish();
      this.continueRemoval(record);
    }
  }
  private withResolvedMetadata(
    options: DownloadOptions | undefined,
    metadata: DownloadMetadata | undefined,
  ): DownloadOptions | undefined {
    return options && metadata
      ? {
          ...options,
          metadata: { ...options.metadata, ...metadata, artists: [...metadata.artists] },
        }
      : options;
  }

  private relativePath(filename: string, options?: DownloadOptions): string {
    const directory = options?.relativeDirectory?.trim().replace(/^[\\/]+|[\\/]+$/g, "");
    return directory ? `${directory}/${filename}` : filename;
  }

  private validRelativePath(value: string): boolean {
    return (
      value.length > 0 &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.includes(String.fromCharCode(0)) &&
      !value.split("/").some((part) => !part || part === "." || part === "..")
    );
  }

  private warningCode(code: string): DownloadWarningCode | undefined {
    return new Set<DownloadWarningCode>([
      "io_error",
      "invalid_request",
      "network_error",
      "http_rejected",
      "limit",
      "payload_rejected",
      "unsupported",
      "atomic_commit_failed",
      "durability_uncertain",
      "partial_committed",
      "sync_failed",
      "cleanup_failed",
      "registration_failed",
      "conflict",
      "cancelled",
      "timeout",
      "revoked",
    ]).has(code as DownloadWarningCode)
      ? (code as DownloadWarningCode)
      : undefined;
  }

  private isSavedOutcome(state: DownloadState): boolean {
    if (!state.done || !state.committed) return false;
    if (["ok", "durability_uncertain", "partial_committed", "sync_failed"].includes(state.code))
      return !!state.ref;
    return [
      "cleanup_failed",
      "registration_failed",
      "conflict",
      "cancelled",
      "timeout",
      "revoked",
    ].includes(state.code);
  }

  private isRetryable(state: DownloadState): boolean {
    return (
      state.done &&
      !state.committed &&
      !["cleanup_failed", "registration_failed", "revoked"].includes(state.code)
    );
  }

  private validState(record: RecordState, state: DownloadState): boolean {
    const previous = record.task;
    return (
      state.operationId === previous.id &&
      new Set([
        "running",
        "ok",
        "io_error",
        "invalid_request",
        "network_error",
        "http_rejected",
        "limit",
        "payload_rejected",
        "unsupported",
        "revoked",
        "conflict",
        "atomic_commit_failed",
        "sync_failed",
        "registration_failed",
        "cleanup_failed",
        "durability_uncertain",
        "partial_committed",
        "sync_failed",
        "cancelled",
        "timeout",
      ]).has(state.code) &&
      !(state.done && state.code === "running") &&
      !(state.code === "durability_uncertain" && (!state.done || !state.committed || !state.ref)) &&
      typeof state.done === "boolean" &&
      typeof state.committed === "boolean" &&
      Number.isSafeInteger(state.received) &&
      state.received >= previous.received &&
      Number.isSafeInteger(state.total) &&
      state.total >= previous.total &&
      (state.total === 0 || state.received <= state.total) &&
      (!previous.committed || state.committed) &&
      (state.filename === undefined || state.filename === previous.filename) &&
      (state.residualName === undefined || this.validRelativePath(state.residualName)) &&
      (state.issues === undefined || validDownloadIssues(state.issues)) &&
      (!state.ref ||
        (state.ref.grantToken === record.token &&
          state.ref.relativePath === this.relativePath(previous.filename, record.recipe?.options) &&
          typeof state.ref.fileId === "string" &&
          !!state.ref.fileId &&
          typeof state.ref.version === "string" &&
          !!state.ref.version)) &&
      !(
        state.done &&
        ["ok", "durability_uncertain", "partial_committed", "sync_failed"].includes(state.code) &&
        (!state.committed ||
          !state.ref ||
          (state.filename !== undefined && state.filename !== previous.filename))
      )
    );
  }
}
