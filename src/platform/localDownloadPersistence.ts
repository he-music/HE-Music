import type {
  DownloadMetadata,
  DownloadOptions,
  DownloadResolveOptions,
  DownloadWarningCode,
} from "./localDownloadSession";
import { createApplicationDatabase } from "./applicationStorage";

export interface LocalDownloadSnapshotSource {
  readonly id: string;
  readonly platform: string;
  readonly name: string;
  readonly links: readonly {
    readonly name: string;
    readonly quality: number;
    readonly format: string;
  }[];
}

/** Durable metadata only: authorization and resolved URLs belong to the live session. */
export interface LocalDownloadSnapshot {
  readonly id: string;
  readonly label: string;
  readonly filename: string;
  readonly quality: string;
  readonly source?: LocalDownloadSnapshotSource;
  readonly display?: {
    readonly artists: string;
    readonly album: string;
    readonly duration: number;
  };
  readonly createdAt?: number;
  readonly completedAt?: number;
  readonly targetDirectory: string;
  readonly options?: DownloadOptions;
  readonly resolveOptions?: DownloadResolveOptions;
  readonly warning?: DownloadWarningCode;
  readonly residualName?: string;
  readonly phase: "active" | "unknown" | "success" | "failed" | "saved";
  readonly done: boolean;
  readonly committed: boolean;
  readonly received: number;
  readonly total: number;
}

export interface LocalDownloadPersistence {
  load(): Promise<readonly LocalDownloadSnapshot[]>;
  save(snapshots: readonly LocalDownloadSnapshot[]): Promise<void>;
}

export interface LocalDownloadStorage {
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: unknown): Promise<unknown>;
}

export const LOCAL_DOWNLOAD_FORMATS = Object.freeze([
  "mp3",
  "wav",
  "flac",
  "aac",
  "webm",
  "m4a",
  "mp4",
  "ogg",
  "aiff",
  "aif",
  "ape",
]);

export function validLocalDownloadFormat(format: string): boolean {
  return LOCAL_DOWNLOAD_FORMATS.includes(format.toLowerCase());
}

const KEY = "history-v1";
const invalid = () => new Error("下载历史数据损坏，原始数据已保留");
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const bytes = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validatedResolveOptions(value: unknown): DownloadResolveOptions | undefined {
  if (value === undefined) return undefined;
  if (
    !object(value) ||
    typeof value.writeLyricTranslation !== "boolean" ||
    typeof value.writeLyricRomaji !== "boolean"
  )
    throw invalid();
  return {
    writeLyricTranslation: value.writeLyricTranslation,
    writeLyricRomaji: value.writeLyricRomaji,
  };
}

function downloadOptions(value: unknown): DownloadOptions | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) throw invalid();
  if (
    typeof value.writeMetadata !== "boolean" ||
    typeof value.writeCover !== "boolean" ||
    typeof value.writeLyrics !== "boolean" ||
    typeof value.saveSidecars !== "boolean"
  )
    throw invalid();
  if (
    value.relativeDirectory !== undefined &&
    (!text(value.relativeDirectory) ||
      value.relativeDirectory.length > 240 ||
      value.relativeDirectory.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw invalid();
  let metadata: DownloadMetadata | undefined;
  if (value.metadata !== undefined) {
    const input = value.metadata;
    if (
      !object(input) ||
      !text(input.title) ||
      !Array.isArray(input.artists) ||
      !input.artists.every(text) ||
      !text(input.album) ||
      !text(input.lyrics) ||
      (input.coverURL !== undefined && !text(input.coverURL))
    )
      throw invalid();
    metadata = {
      title: input.title,
      artists: [...input.artists],
      album: input.album,
      lyrics: input.lyrics,
    };
  }
  return {
    writeMetadata: value.writeMetadata,
    writeCover: value.writeCover,
    writeLyrics: value.writeLyrics,
    saveSidecars: value.saveSidecars,
    ...(value.relativeDirectory !== undefined
      ? { relativeDirectory: value.relativeDirectory }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

/** Explicit projection also strips unknown runtime properties before every write. */
export function localDownloadSnapshot(value: unknown): LocalDownloadSnapshot {
  if (
    !object(value) ||
    !text(value.id) ||
    !value.id ||
    !text(value.label) ||
    !text(value.filename) ||
    !text(value.quality) ||
    !text(value.targetDirectory) ||
    !text(value.phase) ||
    !["active", "unknown", "success", "failed", "saved"].includes(value.phase) ||
    typeof value.done !== "boolean" ||
    typeof value.committed !== "boolean" ||
    !bytes(value.received) ||
    !bytes(value.total) ||
    (value.total !== 0 && value.received > value.total) ||
    ((value.phase === "active" || value.phase === "unknown") && value.done) ||
    (["success", "saved", "failed"].includes(value.phase) && !value.done) ||
    (["success", "saved"].includes(value.phase) && !value.committed) ||
    (value.phase === "failed" && value.committed)
  )
    throw invalid();
  if (value.createdAt !== undefined && !bytes(value.createdAt)) throw invalid();
  if (value.completedAt !== undefined && !bytes(value.completedAt)) throw invalid();
  let display: LocalDownloadSnapshot["display"];
  if (value.display !== undefined) {
    const input = value.display;
    if (
      !object(input) ||
      !text(input.artists) ||
      !text(input.album) ||
      input.artists.length > 4096 ||
      input.album.length > 4096 ||
      typeof input.duration !== "number" ||
      !Number.isFinite(input.duration) ||
      input.duration < 0
    )
      throw invalid();
    display = { artists: input.artists, album: input.album, duration: input.duration };
  }
  const options = downloadOptions(value.options);
  const resolveOptions = validatedResolveOptions(value.resolveOptions);
  const warning = value.warning;
  const validWarnings = [
    "durability_uncertain",
    "partial_committed",
    "sync_failed",
    "cleanup_failed",
    "registration_failed",
    "conflict",
    "cancelled",
    "timeout",
    "revoked",
  ] as const;
  if (
    warning !== undefined &&
    (!text(warning) || !validWarnings.includes(warning as (typeof validWarnings)[number]))
  )
    throw invalid();
  if (
    value.residualName !== undefined &&
    (!text(value.residualName) ||
      value.residualName.startsWith("/") ||
      /^[A-Za-z]:/.test(value.residualName) ||
      value.residualName.includes("\\") ||
      value.residualName.includes(":") ||
      value.residualName.includes(String.fromCharCode(0)) ||
      value.residualName.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw invalid();
  let source: LocalDownloadSnapshotSource | undefined;
  if (value.source !== undefined) {
    const input = value.source;
    if (
      !object(input) ||
      !text(input.id) ||
      !text(input.platform) ||
      !text(input.name) ||
      !Array.isArray(input.links)
    )
      throw invalid();
    const links = input.links.map((link: unknown) => {
      if (
        !object(link) ||
        !text(link.name) ||
        typeof link.quality !== "number" ||
        !Number.isFinite(link.quality) ||
        !text(link.format) ||
        !validLocalDownloadFormat(link.format)
      )
        throw invalid();
      return { name: link.name, quality: link.quality, format: link.format };
    });
    source = { id: input.id, platform: input.platform, name: input.name, links };
  }
  // The phase check above narrows at runtime; spell out the union without a cast.
  const phase =
    value.phase === "active"
      ? "active"
      : value.phase === "unknown"
        ? "unknown"
        : value.phase === "success"
          ? "success"
          : value.phase === "saved"
            ? "saved"
            : "failed";
  return {
    id: value.id,
    label: value.label,
    filename: value.filename,
    quality: value.quality,
    ...(source ? { source } : {}),
    ...(display ? { display } : {}),
    ...(value.createdAt !== undefined ? { createdAt: value.createdAt } : {}),
    ...(value.completedAt !== undefined ? { completedAt: value.completedAt } : {}),
    targetDirectory: value.targetDirectory,
    ...(options ? { options } : {}),
    ...(resolveOptions ? { resolveOptions } : {}),
    ...(warning ? { warning: warning as DownloadWarningCode } : {}),
    ...(value.residualName ? { residualName: value.residualName } : {}),
    phase,
    done: value.done,
    committed: value.committed,
    received: value.received,
    total: value.total,
  };
}

/** A failed/corrupt initial read never authorizes overwriting the existing history. */
export function createLocalDownloadPersistence(
  storage: LocalDownloadStorage = createApplicationDatabase({
    name: "local-data",
    storeName: "local_download_history",
  }),
): LocalDownloadPersistence {
  let loaded = false;
  let loading: Promise<readonly LocalDownloadSnapshot[]> | undefined;
  let writes: Promise<void> = Promise.resolve();
  return {
    load() {
      loading ??= storage.getItem(KEY).then((raw) => {
        if (raw === null) {
          loaded = true;
          return [];
        }
        if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.tasks)) throw invalid();
        const tasks = raw.tasks.map(localDownloadSnapshot);
        if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw invalid();
        loaded = true;
        return tasks;
      });
      return loading;
    },
    save(snapshots) {
      // Capture now, before any queued write or caller mutation can change this version.
      let tasks: LocalDownloadSnapshot[];
      try {
        tasks = snapshots.map(localDownloadSnapshot);
        if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw invalid();
      } catch (error) {
        return Promise.reject(error);
      }
      const write = writes
        .catch(() => {})
        .then(async () => {
          if (!loaded) throw new Error("下载历史尚未成功读取，未覆盖已有数据");
          await storage.setItem(KEY, { version: 1, tasks });
        });
      writes = write;
      return write;
    },
  };
}
