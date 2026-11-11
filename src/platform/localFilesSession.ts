import { computed, shallowRef, watch, type Ref } from "vue";
import type { FileScanAccess, FilesSession } from "./filesSession";
import type { ScanEntry, ScanIssue } from "./mygo.bindings";

interface DirectoryScanIssue extends ScanIssue {
  grantToken: string;
}

type ScanPhase = "idle" | "scanning" | "complete" | "partial" | "failed";

function waitForPage(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 30);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
const entryKey = (entry: ScanEntry) => `${entry.ref.grantToken}\0${entry.relativePath}`;

const activeSession = shallowRef<LocalFilesSession>();
export const localFilesSession = computed(() => activeSession.value);
export function localSongID(entry: ScanEntry): string {
  const directory = activeSession.value?.directoryPath(entry.ref.grantToken);
  return directory
    ? `mygo-local:path:${encodeURIComponent(directory)}/${encodeURIComponent(entry.relativePath)}`
    : `mygo-local:${entry.ref.fileId}`;
}
export function nativeLocalEntry(songID: string): ScanEntry | undefined {
  if (!songID.startsWith("mygo-local:")) return undefined;
  const fileID = songID.slice("mygo-local:".length);
  return activeSession.value?.entries.value.find(
    (entry) => entry.ref.fileId === fileID || localSongID(entry) === songID,
  );
}

/** Transient scan results only: file capabilities never enter persisted song data. */
export class LocalFilesSession {
  private readonly results = shallowRef<readonly ScanEntry[]>([]);
  private readonly downloaded = new Map<string, ScanEntry>();
  private readonly scanIssues = shallowRef<readonly DirectoryScanIssue[]>([]);
  private readonly scanPhase = shallowRef<ScanPhase>("idle");
  readonly entries = computed(() => this.results.value);
  readonly issues = computed(() => this.scanIssues.value);
  readonly phase = computed(() => this.scanPhase.value);
  readonly scanning = computed(() => this.scanPhase.value === "scanning");
  private readonly backgroundSync = shallowRef(false);
  readonly syncing = computed(() => this.backgroundSync.value);
  private revision = 0;
  private disposed = false;
  private abort?: AbortController;
  private operation?: { access: FileScanAccess; id: string };
  private readonly stop: () => void;
  private downloadRefresh?: Promise<void>;
  private downloadRevision = 0;
  private readonly downloadTokens = new Set<string>();
  private refreshAllDownloads = false;

  constructor(private readonly source: Readonly<Ref<FilesSession | undefined>>) {
    activeSession.value = this;
    this.stop = watch(
      () => [source.value, source.value?.ready.value, source.value?.directories.value] as const,
      ([session, ready], [previous]) => {
        this.cancel();
        const tokens = new Set(ready ? session?.directories.value.map((grant) => grant.token) : []);
        for (const [key, entry] of this.downloaded) {
          if (session !== previous || !tokens.has(entry.ref.grantToken))
            this.downloaded.delete(key);
        }
        this.results.value =
          session !== previous
            ? []
            : this.results.value.filter((entry) => tokens.has(entry.ref.grantToken));
        this.scanIssues.value =
          session !== previous
            ? []
            : this.scanIssues.value.filter((issue) => tokens.has(issue.grantToken));
        this.scanPhase.value = "idle";
      },
      { flush: "sync" },
    );
  }

  /** Only live, native-confirmed download references enter this transient index. */
  publishDownloadedFile(entry: ScanEntry): void {
    const owner = this.source.value;
    if (
      this.disposed ||
      !owner?.ready.value ||
      !entry.ref.fileId ||
      !entry.ref.version ||
      entry.relativePath !== entry.ref.relativePath ||
      !owner.directories.value.some((grant) => grant.token === entry.ref.grantToken)
    )
      return;
    this.downloaded.set(entryKey(entry), entry);
    this.results.value = [
      ...this.results.value.filter((item) => entryKey(item) !== entryKey(entry)),
      entry,
    ];
  }

  directoryPath(token: string): string | undefined {
    return this.source.value?.directories.value.find((grant) => grant.token === token)?.displayPath;
  }
  cancel(): void {
    this.revision++;
    this.backgroundSync.value = false;
    this.abort?.abort();
    this.abort = undefined;
    const operation = this.operation;
    this.operation = undefined;
    if (operation) void operation.access.cancel(operation.id).catch(() => {});
    if (this.scanning.value) this.scanPhase.value = "idle";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (activeSession.value === this) activeSession.value = undefined;
    this.cancel();
    this.stop();
    this.results.value = [];
    this.downloaded.clear();
    this.scanIssues.value = [];
  }

  /** Keep published refs while coalescing scans for newly committed downloads. */
  refreshAfterDownload(token?: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Library unavailable"));
    if (token && !this.source.value?.directories.value.some((grant) => grant.token === token))
      return Promise.reject(new Error("Download directory unavailable"));
    this.downloadRevision++;
    if (token) this.downloadTokens.add(token);
    else this.refreshAllDownloads = true;
    if (this.downloadRefresh) return this.downloadRefresh;
    const refresh = async () => {
      let revision: number;
      do {
        revision = this.downloadRevision;
        const tokens = this.refreshAllDownloads ? undefined : new Set(this.downloadTokens);
        this.downloadTokens.clear();
        this.refreshAllDownloads = false;
        await this.scan(tokens);
        if (this.disposed || this.scanPhase.value !== "complete") {
          throw new Error("Library refresh incomplete");
        }
      } while (revision !== this.downloadRevision);
    };
    this.downloadRefresh = refresh().finally(() => {
      this.downloadRefresh = undefined;
    });
    return this.downloadRefresh;
  }

  async refreshAfterWrite(): Promise<void> {
    if (this.disposed) return;
    this.downloaded.clear();
    this.results.value = [];
    const scanning = this.scan();
    const revision = this.revision;
    const signal = this.abort?.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new Error("Library refresh cancelled"));
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      timer = setTimeout(() => {
        reject(new Error("Library refresh timed out"));
        if (!this.disposed && this.revision === revision) {
          this.cancel();
          this.scanPhase.value = "failed";
        }
      }, 300_000);
    });
    try {
      await Promise.race([scanning, cancelled]);
    } finally {
      clearTimeout(timer);
      if (stop) signal?.removeEventListener("abort", stop);
    }
  }

  /** 自动同步只领取空闲扫描；取消时不干扰后来发起的手动扫描或写入刷新。 */
  async refreshWhenIdle(signal: AbortSignal): Promise<void> {
    if (this.disposed || this.scanning.value || signal.aborted) return;
    const pending = this.scan(undefined, true);
    const revision = this.revision;
    const cancel = () => {
      if (this.revision === revision) this.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      await pending;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (this.revision === revision) this.backgroundSync.value = false;
    }
  }

  private publishScan(token: string, entries: ScanEntry[], preserveUnchanged: boolean): void {
    const previous = this.results.value.filter((entry) => entry.ref.grantToken === token);
    const byPath = new Map(previous.map((entry) => [entry.relativePath, entry]));
    const next = preserveUnchanged
      ? entries.map((entry) => {
          const saved = byPath.get(entry.relativePath);
          return saved && JSON.stringify(saved) === JSON.stringify(entry) ? saved : entry;
        })
      : entries;
    if (
      preserveUnchanged &&
      previous.length === next.length &&
      previous.every((entry, index) => entry === next[index])
    )
      return;
    let inserted = false;
    const result = this.results.value.flatMap((entry) => {
      if (entry.ref.grantToken !== token) return [entry];
      if (inserted) return [];
      inserted = true;
      return next;
    });
    this.results.value = inserted ? result : [...result, ...next];
  }

  async scan(tokens?: ReadonlySet<string>, preserveUnchanged = false): Promise<void> {
    if (this.disposed) return;
    this.cancel();
    const session = this.source.value;
    if (!session?.ready.value) return;
    const revision = this.revision;
    const abort = new AbortController();
    this.abort = abort;
    const current = () =>
      !this.disposed &&
      !abort.signal.aborted &&
      this.revision === revision &&
      this.source.value === session &&
      session.ready.value;
    this.backgroundSync.value = preserveUnchanged;
    this.scanPhase.value = "scanning";
    this.scanIssues.value = [];
    let failed = false;
    let partial = false;
    for (const grant of session.directories.value) {
      if (tokens && !tokens.has(grant.token)) continue;
      if (!current()) break;
      const access = session.scanAccess(grant.token);
      if (!access) {
        failed = true;
        continue;
      }
      let operationID: string | undefined;
      let finished = false;
      const downloadedAtStart = new Map(this.downloaded);
      let directoryPartial = false;
      const entries: ScanEntry[] = [];
      try {
        const operation = await access.start();
        operationID = operation.operationId;
        if (!current()) continue;
        this.operation = { access, id: operationID };
        let cursor = "";
        while (current() && access.current()) {
          const page = await access.read(operationID, cursor);
          if (!current() || !access.current()) break;
          if (page.operationId !== operationID || page.nextCursor === cursor) {
            throw new Error("Invalid scan page");
          }
          for (const entry of page.entries) {
            if (
              entry.ref.grantToken !== grant.token ||
              entry.relativePath !== entry.ref.relativePath
            ) {
              throw new Error("Invalid scan file reference");
            }
          }
          entries.push(...page.entries);
          if (page.issues.length) {
            partial = true;
            directoryPartial = true;
            this.scanIssues.value = [
              ...this.scanIssues.value,
              ...page.issues.map((issue) => ({ ...issue, grantToken: grant.token })),
            ].slice(0, 200);
          }
          cursor = page.nextCursor;
          if (page.done) {
            finished = true;
            const scanned = new Set(entries.map(entryKey));
            const retained: ScanEntry[] = [];
            for (const [key, entry] of this.downloaded) {
              if (entry.ref.grantToken !== grant.token) continue;
              if (downloadedAtStart.get(key) !== entry) {
                const previous = entries.findIndex((item) => entryKey(item) === key);
                if (previous >= 0) entries.splice(previous, 1);
                retained.push(entry);
              } else if (scanned.has(key)) this.downloaded.delete(key);
              else if (directoryPartial) retained.push(entry);
              else this.downloaded.delete(key);
            }
            this.publishScan(grant.token, [...entries, ...retained], preserveUnchanged);
            break;
          }
          if (page.entries.length + page.issues.length === 0) await waitForPage(abort.signal);
        }
      } catch {
        if (current()) failed = true;
      } finally {
        if (operationID && !finished) await access.cancel(operationID).catch(() => {});
        if (this.operation?.id === operationID) this.operation = undefined;
      }
    }
    if (current()) {
      this.scanPhase.value = failed ? "failed" : partial ? "partial" : "complete";
      this.abort = undefined;
      this.backgroundSync.value = false;
    }
  }
}
