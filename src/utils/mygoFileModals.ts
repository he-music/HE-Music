import { h, watch, type Component, type Ref } from "vue";
import type { ModalOptions, ModalReactive } from "naive-ui";
import type { SongInfo } from "@/types/main.hemusic";
import { filesSession, type FilesSession } from "@/platform/filesSession";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import type { DirectoryGrant, ScanEntry } from "@/platform/mygo.bindings";
import type { LocalDownloadResolver } from "@/platform/localDownloadSession";
import { songUrl } from "@/api/song";
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
}

/** Request a fresh URL using the original task's frozen source, including on retry. */
export function createMygoDownloadResolver(
  request: (id: string, platform: string, quality: number, format: string) => Promise<unknown>,
): LocalDownloadResolver {
  return async (quality, source) => {
    try {
      const link = source.links.find((item) => item.name === quality);
      const format = link?.format.toLowerCase();
      if (!link || !format || !/^(mp3|flac)$/.test(format)) throw new Error();
      const response = await request(source.id, source.platform, link.quality, link.format);
      if (!response || typeof response !== "object") throw new Error();
      const url = "url" in response ? response.url : undefined;
      const resolvedFormat = "format" in response ? response.format : undefined;
      if (
        typeof url !== "string" ||
        typeof resolvedFormat !== "string" ||
        resolvedFormat.toLowerCase() !== format
      )
        throw new Error();
      const parsed = new URL(url);
      if (!/^(https?:)$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
        throw new Error();
      return { url, format };
    } catch {
      // API exceptions may contain signed URLs; never forward their details to the view.
      throw new Error("Download source unavailable");
    }
  };
}

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
      song.id === `mygo-local:${entry.ref.fileId}` &&
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
        try {
          const result = await owner.chooseDirectory();
          if (view.current() && result.status !== "completed")
            deps.warn("local_download.operation_failed");
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
