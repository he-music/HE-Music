import { computed, shallowRef } from "vue";
import type { PlatformFiles } from "./files";
import { LocalFilesSession } from "./localFilesSession";
import { LocalMetadataSession } from "./localMetadataSession";
import { LocalDownloadSession } from "./localDownloadSession";
import type {
  DefaultDirectoryKind,
  DefaultDirectoryResult,
  DirectoryGrant,
  DirectorySelection,
  RendererSettings,
  SettingsImportResult,
  SettingsExportResult,
  ScanOperation,
  ScanPage,
  LocalAudioTicket,
  LocalFileRef,
  MetadataResult,
  MetadataSaveRequest,
  DownloadRequest,
  DownloadOperation,
  DownloadState,
} from "./mygo.bindings";

export interface FileScanAccess {
  current(): boolean;
  start(): Promise<ScanOperation>;
  read(operationID: string, cursor: string): Promise<ScanPage>;
  cancel(operationID: string): Promise<void>;
}

export interface LocalAudioAccess {
  current(): boolean;
  open(): Promise<LocalAudioTicket>;
  close(ticketID: string): Promise<void>;
}

export interface FileMetadataAccess {
  current(): boolean;
  read(): Promise<MetadataResult>;
  save(request: MetadataSaveRequest): Promise<MetadataResult>;
  cancel(operationID: string): Promise<MetadataResult>;
}

export interface FileDownloadAccess {
  current(): boolean;
  start(request: DownloadRequest): Promise<DownloadOperation>;
  read(operationID: string): Promise<DownloadState>;
  cancel(operationID: string): Promise<DownloadState>;
}

export type FileOperationResult<T> =
  { status: "completed"; value: T } | { status: "busy" | "unavailable" | "stale" | "failed" };

const activeSession = shallowRef<FilesSession>();
export const filesSession = computed(() => activeSession.value);

export interface FilesSessionDependencies {
  blockAudio(): () => void;
}

export class FilesSession {
  readonly metadata?: LocalMetadataSession;
  readonly downloads?: LocalDownloadSession;
  readonly ready = shallowRef(false);
  readonly busy = shallowRef(false);
  private readonly directoryGrants = shallowRef<readonly DirectoryGrant[]>([]);
  readonly directories = computed(() => this.directoryGrants.value);
  private epoch: number | undefined;
  private disposed = false;
  private started = false;
  private beginning: Promise<void> | undefined;
  private cleanup: Promise<void> | undefined;
  private local?: LocalFilesSession;

  constructor(
    private readonly provider: PlatformFiles,
    deps?: FilesSessionDependencies,
  ) {
    if (deps && provider.readMetadata && provider.saveMetadata && provider.cancelMetadata) {
      this.metadata = new LocalMetadataSession({
        access: (ref) => this.metadataAccess(ref),
        blockAudio: deps.blockAudio,
        refreshLibrary: async () => {
          const local = this.local;
          if (this.disposed || !this.ready.value || !local) throw new Error("Files unavailable");
          await local.refreshAfterWrite();
          if (
            this.disposed ||
            !this.ready.value ||
            this.local !== local ||
            local.phase.value !== "complete"
          ) {
            throw new Error("Library refresh incomplete");
          }
        },
      });
    }
    if (provider.startDownload && provider.readDownloadState && provider.cancelDownload) {
      this.downloads = new LocalDownloadSession({
        access: (token) => this.downloadAccess(token),
        onCommitted: async () => {
          const local = this.local;
          if (this.disposed || !this.ready.value || !local) throw new Error("Files unavailable");
          await local.scan();
          if (
            this.disposed ||
            !this.ready.value ||
            this.local !== local ||
            local.phase.value !== "complete"
          ) {
            throw new Error("Library refresh incomplete");
          }
        },
      });
    }
  }

  start(): Promise<void> {
    if (this.started || this.disposed) return this.beginning ?? Promise.resolve();
    this.started = true;
    this.beginning = this.initialize();
    return this.beginning;
  }

  private async initialize(): Promise<void> {
    try {
      const { epoch } = await this.provider.begin();
      if (this.disposed) {
        await this.provider.teardown(epoch).catch(() => {});
        return;
      }
      this.epoch = epoch;
      this.ready.value = true;
      activeSession.value = this;
      this.local = new LocalFilesSession(shallowRef(this));
    } catch {
      // File capability failure must not fail the media, shortcut or tray lifecycle.
      console.error("文件会话初始化失败");
    }
  }

  dispose(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.disposed = true;
    this.metadata?.dispose();
    this.downloads?.dispose();
    this.local?.dispose();
    this.local = undefined;
    this.ready.value = false;
    this.directoryGrants.value = [];
    if (activeSession.value === this) activeSession.value = undefined;
    const epoch = this.epoch;
    this.epoch = undefined;
    // Do not wait for a pending picker before invalidating the native owner.
    this.cleanup =
      epoch === undefined
        ? (this.beginning ?? Promise.resolve())
        : this.provider.teardown(epoch).catch(() => {});
    return this.cleanup;
  }

  importSettings(): Promise<FileOperationResult<SettingsImportResult>> {
    return this.run((epoch) => this.provider.importSettings(epoch));
  }

  exportSettings(settings: RendererSettings): Promise<FileOperationResult<SettingsExportResult>> {
    return this.run((epoch) => this.provider.exportSettings(epoch, settings));
  }

  chooseDirectory(): Promise<FileOperationResult<DirectorySelection>> {
    return this.run(async (epoch) => {
      const selection = await this.provider.chooseDirectory(epoch);
      if (
        !this.disposed &&
        this.epoch === epoch &&
        selection.status === "selected" &&
        selection.grant?.epoch === epoch
      ) {
        const grant = selection.grant;
        this.directoryGrants.value = [
          ...this.directoryGrants.value.filter((item) => item.token !== grant.token),
          grant,
        ];
      }
      return selection;
    });
  }

  defaultDirectory(
    kind: DefaultDirectoryKind,
  ): Promise<FileOperationResult<DefaultDirectoryResult>> {
    return this.run((epoch) => this.provider.defaultDirectory(epoch, kind));
  }

  revokeDirectory(token: string): Promise<FileOperationResult<void>> {
    return this.run(async (epoch) => {
      await this.provider.revokeDirectory(epoch, token);
      if (!this.disposed && this.epoch === epoch) {
        this.directoryGrants.value = this.directoryGrants.value.filter(
          (item) => item.token !== token,
        );
        if (this.metadata?.operation?.ref.grantToken === token) this.metadata.invalidate();
        this.downloads?.invalidate(token);
      }
    });
  }

  audioAccess(ref: LocalFileRef): LocalAudioAccess | undefined {
    const { openLocalAudio, closeLocalAudio } = this.provider;
    const epoch = this.epoch;
    const current = () =>
      !this.disposed &&
      this.ready.value &&
      this.epoch === epoch &&
      this.directoryGrants.value.some(
        (grant) => grant.token === ref.grantToken && grant.epoch === epoch,
      );
    if (!current() || epoch === undefined || !openLocalAudio || !closeLocalAudio) return undefined;
    return {
      current,
      open: async () => {
        if (!current()) throw new Error("Local audio authorization expired");
        const ticket = await openLocalAudio(epoch, ref);
        if (!current()) {
          await closeLocalAudio(epoch, ticket.ticketId).catch(() => {});
          throw new Error("Local audio authorization expired");
        }
        return ticket;
      },
      close: (ticketID) => closeLocalAudio(epoch, ticketID),
    };
  }

  private captureGrant(token: string) {
    const epoch = this.epoch;
    if (epoch === undefined) return;
    const current = () =>
      !this.disposed &&
      this.ready.value &&
      this.epoch === epoch &&
      this.directoryGrants.value.some((grant) => grant.token === token && grant.epoch === epoch);
    return current() ? { epoch, current } : undefined;
  }

  metadataAccess(ref: LocalFileRef): FileMetadataAccess | undefined {
    const captured = { ...ref };
    const grant = this.captureGrant(captured.grantToken);
    const { readMetadata, saveMetadata, cancelMetadata } = this.provider;
    if (!grant || !readMetadata || !saveMetadata || !cancelMetadata) return;
    const { epoch, current } = grant;
    const ownedResult = (result: MetadataResult): MetadataResult =>
      current() ? result : { code: "revoked", committed: result.committed };
    return {
      current,
      read: async () => {
        if (!current()) throw new Error("Metadata authorization expired");
        return ownedResult(await readMetadata(epoch, captured));
      },
      save: async (request) => {
        if (
          !current() ||
          request.ref.grantToken !== captured.grantToken ||
          request.ref.relativePath !== captured.relativePath ||
          request.ref.fileId !== captured.fileId ||
          request.ref.version !== captured.version
        )
          throw new Error("Metadata authorization expired");
        return ownedResult(await saveMetadata(epoch, request));
      },
      cancel: (operationID) => cancelMetadata(epoch, operationID),
    };
  }

  downloadAccess(token: string): FileDownloadAccess | undefined {
    const grant = this.captureGrant(token);
    const { startDownload, readDownloadState, cancelDownload } = this.provider;
    if (!grant || !startDownload || !readDownloadState || !cancelDownload) return;
    const { epoch, current } = grant;
    return {
      current,
      start: async (request) => {
        if (!current() || request.grantToken !== token)
          throw new Error("Download authorization expired");
        const captured = { ...request };
        const operationID = captured.operationId;
        const operation = await startDownload(epoch, captured);
        if (!current()) {
          void cancelDownload(epoch, operationID).catch(() => {});
          throw new Error("Download authorization expired");
        }
        return operation;
      },
      read: async (operationID) => {
        if (!current()) throw new Error("Download authorization expired");
        const state = await readDownloadState(epoch, operationID);
        if (!current()) throw new Error("Download authorization expired");
        return state;
      },
      cancel: (operationID) => cancelDownload(epoch, operationID),
    };
  }

  /** A scan captures the shell's current grant without occupying the picker slot. */
  scanAccess(token: string): FileScanAccess | undefined {
    const { startScan, readScanPage, cancelFileOperation } = this.provider;
    const epoch = this.epoch;
    const current = () =>
      !this.disposed &&
      this.ready.value &&
      this.epoch === epoch &&
      epoch !== undefined &&
      this.directoryGrants.value.some((grant) => grant.token === token && grant.epoch === epoch);
    if (!current() || epoch === undefined || !startScan || !readScanPage || !cancelFileOperation) {
      return undefined;
    }
    return {
      current,
      start: async () => {
        if (!current()) throw new Error("File scan is no longer active");
        const result = await startScan(epoch, token);
        if (!current()) {
          await cancelFileOperation(epoch, result.operationId).catch(() => {});
          throw new Error("File scan is no longer active");
        }
        return result;
      },
      read: async (operationID, cursor) => {
        if (!current()) throw new Error("File scan is no longer active");
        const result = await readScanPage(epoch, operationID, cursor);
        if (!current()) throw new Error("File scan is no longer active");
        return result;
      },
      cancel: (operationID) => cancelFileOperation(epoch, operationID),
    };
  }

  private async run<T>(operation: (epoch: number) => Promise<T>): Promise<FileOperationResult<T>> {
    if (this.disposed || !this.ready.value || this.epoch === undefined) {
      return { status: "unavailable" };
    }
    if (this.busy.value) return { status: "busy" };
    const epoch = this.epoch;
    this.busy.value = true;
    try {
      const value = await operation(epoch);
      if (this.disposed || this.epoch !== epoch) return { status: "stale" };
      return { status: "completed", value };
    } catch (error) {
      if (this.disposed || this.epoch !== epoch) return { status: "stale" };
      return {
        status:
          error instanceof Error && error.message === "native file operation is busy"
            ? "busy"
            : "failed",
      };
    } finally {
      this.busy.value = false;
    }
  }
}

export function createFilesSession(
  provider?: PlatformFiles,
  deps?: FilesSessionDependencies,
): FilesSession | undefined {
  return provider ? new FilesSession(provider, deps) : undefined;
}
