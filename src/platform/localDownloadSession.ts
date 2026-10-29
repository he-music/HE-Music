import { computed, shallowRef } from "vue";
import type { DownloadOperation, DownloadRequest, DownloadState } from "./mygo.bindings";
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
) => Promise<{ url: string; format: string }>;

/** Copy only resolver inputs; link URLs and song credentials never become retry data. */
export function localDownloadSource(source: LocalDownloadSource): LocalDownloadSource {
  return Object.freeze({
    id: source.id,
    platform: source.platform,
    name: source.name,
    links: Object.freeze(
      source.links
        .filter((link) => validLocalDownloadFormat(link.format))
        .map(({ name, quality, format, size }) => Object.freeze({ name, quality, format, size })),
    ),
  });
}
export interface LocalDownloadInput {
  grantToken: string;
  filename: string;
  url: string;
  label: string;
  quality: string;
  source: LocalDownloadSource;
  resolveURL: LocalDownloadResolver;
}
export interface LocalDownloadTask {
  readonly id: string;
  readonly filename: string;
  readonly label: string;
  readonly quality: string;
  readonly phase: "active" | "unknown" | "success" | "failed" | "saved";
  readonly done: boolean;
  readonly committed: boolean;
  readonly received: number;
  readonly total: number;
  readonly percent: number | undefined;
  readonly refresh: "none" | "pending" | "complete" | "failed";
  readonly retryable: boolean;
  readonly interrupted?: boolean;
}
interface RecordState {
  task: LocalDownloadTask;
  token: string;
  access: LocalDownloadAccess;
  sequence: number;
  pending: Set<() => void>;
  retrying: boolean;
  retiring?: boolean;
  recipe?: {
    quality: string;
    source: LocalDownloadSource;
    resolveURL: LocalDownloadResolver;
  };
  targetDirectory: string;
  timer?: ReturnType<typeof setTimeout>;
}
export function validDownloadFilename(name: string): boolean {
  return (
    new TextEncoder().encode(name).length <= 240 &&
    name.trim() === name &&
    !name.startsWith(".") &&
    !/[\\/:<>"|?*\p{Cc}]/u.test(name) &&
    !/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:[ .]|$)/i.test(name) &&
    validLocalDownloadFormat(name.slice(name.lastIndexOf(".") + 1)) &&
    name.includes(".")
  );
}
function validURL(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
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
  constructor(
    private readonly deps: {
      access(token: string): LocalDownloadAccess | undefined;
      onCommitted(): Promise<void>;
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
    const interrupted = !snapshot.done;
    return {
      id: snapshot.id,
      filename: snapshot.filename,
      label: snapshot.label,
      quality: snapshot.quality,
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
      retryable:
        !snapshot.committed &&
        !!snapshot.source &&
        !!snapshot.targetDirectory &&
        !!this.deps.directoryToken &&
        !!this.deps.resolveURL,
    };
  }

  async start(input: LocalDownloadInput): Promise<string | undefined> {
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
      !validURL(input.url)
    )
      return undefined;
    const access = this.deps.access(input.grantToken);
    if (!access?.current()) return undefined;
    const id = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const record: RecordState = {
      task: {
        id,
        filename: input.filename,
        label: input.label,
        quality: input.quality,
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
      retrying: false,
      recipe: {
        quality: input.quality,
        source: localDownloadSource(input.source),
        resolveURL: input.resolveURL,
      },
      targetDirectory: this.deps.directoryPath?.(input.grantToken) ?? "",
    };
    this.records.set(id, record);
    this.touched.add(id);
    this.publish();
    try {
      const result = await this.bounded(
        () =>
          access.start({
            operationId: id,
            grantToken: input.grantToken,
            filename: input.filename,
            url: input.url,
          }),
        record,
      );
      if (this.current(record) && result.operationId !== id) this.unknown(record);
    } catch {
      if (this.current(record)) this.unknown(record);
    }
    // Lost Start responses are recovered only by reads of the original id.
    if (this.current(record)) this.schedule(record);
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
      const result = await this.bounded(() => resolveURL(snapshot.quality, source));
      if (
        this.disposed ||
        this.archived.get(id) !== snapshot ||
        !access.current() ||
        this.deps.directoryToken?.(snapshot.targetDirectory) !== token ||
        !this.validResolvedFormat(snapshot.filename, snapshot.quality, source, result.format)
      )
        return;
      return await this.start({
        grantToken: token,
        filename: snapshot.filename,
        label: snapshot.label,
        quality: snapshot.quality,
        source,
        resolveURL,
        url: result.url,
      });
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
      format === link.format.toLowerCase() &&
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
      record.retiring
    )
      return undefined;
    record.retrying = true;
    try {
      const result = await this.bounded(
        () => recipe.resolveURL(recipe.quality, recipe.source),
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
      return await this.start({
        grantToken: record.token,
        filename: record.task.filename,
        label: record.task.label,
        quality: recipe.quality,
        source: recipe.source,
        resolveURL: recipe.resolveURL,
        url: result.url,
      });
    } catch {
      return undefined;
    } finally {
      record.retrying = false;
    }
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
      record.task.refresh === "pending" ||
      !forget
    )
      return false;
    record.retiring = true;
    try {
      const forgotten = await this.bounded(() => forget(id), record);
      if (!forgotten || !this.current(record)) return false;
      this.records.delete(id);
      this.touched.add(id);
      clearTimeout(record.timer);
      record.recipe = undefined;
      record.token = "";
      this.publish();
      return true;
    } catch {
      return false;
    } finally {
      record.retiring = false;
    }
  }
  async refresh(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || !this.current(record) || record.task.done) return;
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
      if (this.deps.persistence) {
        try {
          this.archived.set(
            record.task.id,
            localDownloadSnapshot({
              ...record.task,
              source: record.recipe?.source,
              targetDirectory: record.targetDirectory,
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
      for (const stop of [...record.pending]) stop();
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
  private bounded<T>(run: () => Promise<T>, record?: RecordState): Promise<T> {
    return new Promise((resolve, reject) => {
      let active = true;
      const stop = () => {
        active = false;
        clearTimeout(timer);
        record?.pending.delete(stop);
        reject(new Error("Unavailable"));
      };
      const timer = setTimeout(stop, 3000);
      record?.pending.add(stop);
      Promise.resolve()
        .then(() => {
          if (!active) throw new Error("Unavailable");
          return run();
        })
        .then((value) => {
          clearTimeout(timer);
          record?.pending.delete(stop);
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
      const success = state.done && state.code === "ok" && state.committed && !!state.ref;
      record.task = {
        ...record.task,
        done: state.done,
        committed: state.committed,
        received: state.received,
        total: state.total,
        percent: success
          ? 100
          : state.total
            ? Math.min(99, Math.floor((state.received / state.total) * 100))
            : undefined,
        phase: success ? "success" : state.done ? (state.committed ? "saved" : "failed") : "active",
        retryable: state.done && !state.committed && state.code !== "ok",
      };
      if (state.done && state.committed) {
        record.task = { ...record.task, refresh: "pending" };
        this.publish();
        try {
          await this.bounded(() => this.deps.onCommitted(), record);
          if (this.current(record)) record.task = { ...record.task, refresh: "complete" };
        } catch {
          if (this.current(record)) record.task = { ...record.task, refresh: "failed" };
        }
      }
      if (this.current(record)) this.publish();
    } catch {
      if (this.current(record) && !record.task.done && sequence === record.sequence)
        this.unknown(record);
    } finally {
      if (this.current(record)) this.schedule(record);
    }
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
        "cancelled",
        "timeout",
      ]).has(state.code) &&
      !(state.done && state.code === "running") &&
      typeof state.done === "boolean" &&
      typeof state.committed === "boolean" &&
      Number.isSafeInteger(state.received) &&
      state.received >= previous.received &&
      Number.isSafeInteger(state.total) &&
      state.total >= previous.total &&
      (state.total === 0 || state.received <= state.total) &&
      (!previous.committed || state.committed) &&
      (state.filename === undefined || state.filename === previous.filename) &&
      (!state.ref ||
        (state.ref.grantToken === record.token &&
          state.ref.relativePath === previous.filename &&
          typeof state.ref.fileId === "string" &&
          !!state.ref.fileId &&
          typeof state.ref.version === "string" &&
          !!state.ref.version)) &&
      !(
        state.done &&
        state.code === "ok" &&
        (!state.committed || !state.ref || state.filename !== previous.filename)
      )
    );
  }
}
