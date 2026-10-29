import { computed, shallowRef } from "vue";
import type { DownloadOperation, DownloadRequest, DownloadState } from "./mygo.bindings";

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
      source.links.map(({ name, quality, format, size }) =>
        Object.freeze({ name, quality, format, size }),
      ),
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
}
interface RecordState {
  task: LocalDownloadTask;
  token: string;
  access: LocalDownloadAccess;
  sequence: number;
  pending: Set<() => void>;
  retrying: boolean;
  retiring?: boolean;
  recipe?: { quality: string; source: LocalDownloadSource; resolveURL: LocalDownloadResolver };
  expires: number;
  timer?: ReturnType<typeof setTimeout>;
}
const MAX_BYTES = 32 * 1024 * 1024;
export function validDownloadFilename(name: string): boolean {
  return (
    new TextEncoder().encode(name).length <= 240 &&
    name.trim() === name &&
    !name.startsWith(".") &&
    !/[\\/:<>"|?*\p{Cc}]/u.test(name) &&
    !/^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:[ .]|$)/i.test(name) &&
    /\.(mp3|flac)$/i.test(name)
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

/** Owned by FilesSession; closing a view must not dispose this transient queue. */
export class LocalDownloadSession {
  private readonly list = shallowRef<readonly LocalDownloadTask[]>([]);
  readonly tasks = computed(() => this.list.value);
  private readonly records = new Map<string, RecordState>();
  private disposed = false;
  constructor(
    private readonly deps: {
      access(token: string): LocalDownloadAccess | undefined;
      onCommitted(): Promise<void>;
    },
  ) {}

  async start(input: LocalDownloadInput): Promise<string | undefined> {
    if (
      this.disposed ||
      this.records.size >= 64 ||
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
      expires: Date.now() + 120_000,
    };
    this.records.set(id, record);
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

  async retry(id: string): Promise<string | undefined> {
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
      if (!this.current(record) || record.recipe !== recipe || !record.task.retryable)
        return undefined;
      const format = result.format.toLowerCase();
      const link = recipe.source.links.find((item) => item.name === recipe.quality);
      if (
        !link ||
        !/^(mp3|flac)$/.test(format) ||
        format !== link.format.toLowerCase() ||
        !record.task.filename.toLowerCase().endsWith(`.${format}`)
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
      this.records.delete(record.task.id);
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
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }
  private current(record: RecordState): boolean {
    return !this.disposed && this.records.get(record.task.id) === record && record.access.current();
  }
  private publish(): void {
    this.list.value = [...this.records.values()].map((record) => record.task);
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
    if (Date.now() >= record.expires) {
      this.unknown(record);
      return;
    }
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
      state.received <= MAX_BYTES &&
      Number.isSafeInteger(state.total) &&
      state.total >= previous.total &&
      state.total <= MAX_BYTES &&
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
