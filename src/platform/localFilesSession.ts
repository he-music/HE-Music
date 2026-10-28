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

const activeSession = shallowRef<LocalFilesSession>();
export const localFilesSession = computed(() => activeSession.value);
export function nativeLocalEntry(songID: string): ScanEntry | undefined {
  if (!songID.startsWith("mygo-local:")) return undefined;
  const fileID = songID.slice("mygo-local:".length);
  return activeSession.value?.entries.value.find((entry) => entry.ref.fileId === fileID);
}

/** Transient scan results only: file capabilities never enter persisted song data. */
export class LocalFilesSession {
  private readonly results = shallowRef<readonly ScanEntry[]>([]);
  private readonly scanIssues = shallowRef<readonly DirectoryScanIssue[]>([]);
  private readonly scanPhase = shallowRef<ScanPhase>("idle");
  readonly entries = computed(() => this.results.value);
  readonly issues = computed(() => this.scanIssues.value);
  readonly phase = computed(() => this.scanPhase.value);
  readonly scanning = computed(() => this.scanPhase.value === "scanning");
  private revision = 0;
  private disposed = false;
  private abort?: AbortController;
  private operation?: { access: FileScanAccess; id: string };
  private readonly stop: () => void;

  constructor(private readonly source: Readonly<Ref<FilesSession | undefined>>) {
    activeSession.value = this;
    this.stop = watch(
      () => [source.value, source.value?.ready.value, source.value?.directories.value] as const,
      ([session, ready], [previous]) => {
        this.cancel();
        const tokens = new Set(ready ? session?.directories.value.map((grant) => grant.token) : []);
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

  cancel(): void {
    this.revision++;
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
    this.scanIssues.value = [];
  }

  async scan(): Promise<void> {
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
    this.scanPhase.value = "scanning";
    this.scanIssues.value = [];
    let failed = false;
    let partial = false;
    for (const grant of session.directories.value) {
      if (!current()) break;
      const access = session.scanAccess(grant.token);
      if (!access) {
        failed = true;
        continue;
      }
      let operationID: string | undefined;
      let finished = false;
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
            this.scanIssues.value = [
              ...this.scanIssues.value,
              ...page.issues.map((issue) => ({ ...issue, grantToken: grant.token })),
            ].slice(0, 200);
          }
          cursor = page.nextCursor;
          if (page.done) {
            finished = true;
            this.results.value = [
              ...this.results.value.filter((entry) => entry.ref.grantToken !== grant.token),
              ...entries,
            ];
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
    }
  }
}
