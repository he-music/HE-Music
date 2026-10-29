import { h, watch, type Component, type Ref } from "vue";
import type { ModalOptions, ModalReactive } from "naive-ui";
import type { SongInfo } from "@/types/main.hemusic";
import { filesSession, type FilesSession } from "@/platform/filesSession";
import { nativeLocalEntry, localFilesSession } from "@/platform/localFilesSession";
import type { DirectoryGrant, ScanEntry } from "@/platform/mygo.bindings";
import type { LocalDownloadResolver } from "@/platform/localDownloadSession";
import { songUrl } from "@/api/song";
import { createMygoDownloadResolver } from "./localDownloadResolver";
import { t } from "@/i18n";

export interface MygoModalOwner extends Pick<
  FilesSession,
  "ready" | "metadata" | "downloads" | "chooseDirectory" | "metadataAccess"
> {
  readonly directories: Readonly<Ref<readonly DirectoryGrant[]>>;
}
type Loader = () => Promise<{ default: Component }>;
export interface MygoFileModalDependencies {
  owner: Readonly<Ref<MygoModalOwner | undefined>>;
  entry(songID: string): ScanEntry | undefined;
  loadEditor: Loader;
  loadDownload: Loader;
  create(options: ModalOptions): Pick<ModalReactive, "destroy">;
  warn(key: string): void;
  translate(key: string): string;
  resolveURL: LocalDownloadResolver;
  scanLibrary?(owner: MygoModalOwner): Promise<void>;
}

export { createMygoDownloadResolver } from "./localDownloadResolver";

interface View {
  current(): boolean;
  close(): void;
}

export function createMygoFileModals(deps: MygoFileModalDependencies) {
  let editor: View | undefined;
  let download: View | undefined;

  async function open(kind: "editor" | "download", song: SongInfo): Promise<void> {
    if (!song) {
      deps.warn("message.please_select_song");
      return;
    }
    const owner = deps.owner.value;
    const namespace = kind === "editor" ? "local_metadata" : "local_download";
    if (!owner?.ready.value || !(kind === "editor" ? owner.metadata : owner.downloads)) {
      deps.warn(`${namespace}.unavailable`);
      return;
    }
    const metadata = owner.metadata;
    const downloads = owner.downloads;
    const entry = kind === "editor" ? deps.entry(song.id) : undefined;
    const refKey = entry ? JSON.stringify(entry.ref) : "";
    const access = entry ? owner.metadataAccess(entry.ref) : undefined;
    let opened = false;
    const entryCurrent = () =>
      song.platform === "local" &&
      !!entry &&
      song.path === entry.relativePath &&
      entry.relativePath === entry.ref.relativePath &&
      deps.entry(song.id) === entry &&
      JSON.stringify(entry.ref) === refKey;
    const current = () =>
      deps.owner.value === owner &&
      owner.ready.value &&
      (kind === "download"
        ? owner.downloads === downloads
        : owner.metadata === metadata &&
          (access?.current() ?? false) &&
          (opened || entryCurrent()));
    if (!current()) {
      deps.warn(`${namespace}.entry_changed`);
      return;
    }
    const previous = kind === "editor" ? editor : download;
    if (previous?.current()) return;
    previous?.close();
    let modal: Pick<ModalReactive, "destroy"> | undefined;
    let stopped = false;
    let stop = () => {};
    const release = () => {
      if (stopped) return;
      stopped = true;
      stop();
      if (kind === "editor" && editor === view) editor = undefined;
      if (kind === "download" && download === view) download = undefined;
    };
    const close = () => {
      if (stopped) return;
      release();
      modal?.destroy();
    };
    const view: View = { current: () => !stopped && current(), close };
    if (kind === "editor") editor = view;
    else download = view;
    stop = watch(
      current,
      (valid) => {
        if (!valid) close();
      },
      { flush: "sync" },
    );
    try {
      const { default: component } = await (kind === "editor"
        ? deps.loadEditor()
        : deps.loadDownload());
      // Invalidated imports may still resolve after a newer owner has opened its view.
      if (!view.current()) {
        close();
        return;
      }
      const chooseDirectory = async () => {
        if (!view.current()) return;
        const tokens = new Set(owner.directories.value.map((grant) => grant.token));
        try {
          const result = await owner.chooseDirectory();
          if (!view.current()) return;
          if (result.status !== "completed") {
            deps.warn("local_download.operation_failed");
            return;
          }
          const { grant, status } = result.value;
          if (
            status === "selected" &&
            grant &&
            !tokens.has(grant.token) &&
            owner.directories.value.some(
              (item) => item.token === grant.token && item.epoch === grant.epoch,
            )
          ) {
            await deps.scanLibrary?.(owner);
          }
        } catch {
          if (view.current()) deps.warn("local_download.operation_failed");
        }
      };
      // A save clears the registry before rescanning. Keep its completion and recovery view alive.
      opened = true;
      modal = deps.create({
        preset: "card",
        transformOrigin: "center",
        autoFocus: false,
        ...(kind === "editor" ? { trapFocus: false } : {}),
        style: { width: "600px" },
        title: deps.translate(kind === "editor" ? "modal.song_info_edit" : "common.download_song"),
        content: () =>
          kind === "editor"
            ? h(component, { entry, session: metadata, onClose: close })
            : h(component, {
                song,
                session: downloads,
                grants: owner.directories.value,
                chooseDirectory,
                resolveURL: deps.resolveURL,
                onClose: close,
              }),
        onClose: release,
        onUpdateShow: (show) => {
          if (!show) release();
        },
        onAfterLeave: release,
      });
      if (stopped) modal.destroy();
    } catch {
      if (view.current()) deps.warn(`${namespace}.unavailable`);
      close();
    }
  }

  return {
    openMygoSongInfoEditor: (song: SongInfo) => open("editor", song),
    openMygoDownloadSong: (song: SongInfo) => open("download", song),
  };
}

const modals = createMygoFileModals({
  owner: filesSession,
  entry: nativeLocalEntry,
  scanLibrary: async (owner) => {
    if (filesSession.value === owner && owner.ready.value) await localFilesSession.value?.scan();
  },
  loadEditor: () => import("@/components/Modal/MygoSongInfoEditor.vue"),
  loadDownload: () => import("@/components/Modal/MygoDownload.vue"),
  create: (options) => window.$modal.create(options),
  warn: (key) => window.$message.warning(t(key)),
  translate: t,
  resolveURL: createMygoDownloadResolver((id, sourcePlatform, quality, format) =>
    songUrl(id, sourcePlatform, quality, format, { skipErrorMessage: true }),
  ),
});
export const { openMygoSongInfoEditor, openMygoDownloadSong } = modals;
