import { shallowRef, watch } from "vue";
import { platform } from "@/platform";
import { useMusicStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { filesSession } from "@/platform/filesSession";
import type { ScanEntry } from "@/platform/mygo.bindings";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import { readLocalDisplay } from "../platform/localDisplayRead";
import { installLocalArtworkReader, ownsLocalArtworkReader } from "@/platform/localArtwork";
import {
  LocalArtworkSession,
  type LocalArtworkTarget,
  type LocalArtworkView,
} from "@/platform/localArtworkSession";

interface ArtworkDependencies {
  createURL?: (bytes: ArrayBuffer, mime: string) => string;
  revokeURL?: (url: string) => void;
  onTheme?: (url: string) => void | Promise<void>;
}
const sameTarget = (left: LocalArtworkTarget | undefined, right: LocalArtworkTarget | undefined) =>
  left === right ||
  Boolean(
    left &&
    right &&
    left.owner === right.owner &&
    left.songID === right.songID &&
    left.platform === right.platform &&
    left.relativePath === right.relativePath &&
    left.ref.grantToken === right.ref.grantToken &&
    left.ref.fileId === right.ref.fileId &&
    left.ref.version === right.ref.version &&
    left.ref.relativePath === right.ref.relativePath,
  );

export function createShellLocalArtworkSession(deps: ArtworkDependencies = {}) {
  if (platform.kind !== "mygo" || !platform.files || !("readLocalArtwork" in platform.files))
    return;
  const music = useMusicStore();
  const view = shallowRef<LocalArtworkView>();
  let desired: LocalArtworkTarget | undefined;
  let desiredEntry: ScanEntry | undefined;
  let disposed = false;
  let lastTheme: string | undefined;
  const onTheme = deps.onTheme ?? ((url: string) => usePlayer().updateArtworkTheme(url));
  const theme = (url: string) => {
    if (!ownsLocalArtworkReader(reader) || lastTheme === url) return;
    lastTheme = url;
    try {
      void Promise.resolve(onTheme(url)).catch(() => {});
    } catch {
      /* 配色失败不改变 URL 所有权。 */
    }
  };
  const current = (target: LocalArtworkTarget): boolean => {
    const owner = filesSession.value;
    const song = music.playSong;
    const entry = nativeLocalEntry(target.songID);
    return Boolean(
      !disposed &&
      ownsLocalArtworkReader(reader) &&
      owner === target.owner &&
      owner?.ready.value &&
      song.id === target.songID &&
      song.platform === target.platform &&
      song.path === target.relativePath &&
      target.ref.relativePath === target.relativePath &&
      entry === desiredEntry &&
      entry?.relativePath === target.relativePath &&
      entry.ref.grantToken === target.ref.grantToken &&
      entry.ref.fileId === target.ref.fileId &&
      entry.ref.version === target.ref.version &&
      entry.ref.relativePath === target.ref.relativePath &&
      owner.directories.value.some((grant) => grant.token === target.ref.grantToken),
    );
  };
  const session = new LocalArtworkSession({
    current,
    read: (target) => {
      const owner = filesSession.value;
      if (!owner || !current(target)) return Promise.resolve(undefined);
      return readLocalDisplay(owner, target.ref, "artwork", desiredEntry);
    },
    createURL:
      deps.createURL ?? ((bytes, mime) => URL.createObjectURL(new Blob([bytes], { type: mime }))),
    revokeURL: deps.revokeURL ?? ((url) => URL.revokeObjectURL(url)),
    onChange: (next) => {
      view.value = next;
      if (!disposed && next && desired && current(desired)) theme(next.url);
    },
  });
  // view 是派生状态的依赖；lease 先行复核避免在 Store getter 中执行失权清理。
  const reader = (songID: string, source: string, path: string): string | undefined => {
    if (!view.value || !desired || !current(desired)) return undefined;
    return session.currentURL(songID, source, path);
  };
  const release = installLocalArtworkReader(reader);
  const update = () => {
    const owner = filesSession.value;
    const song = music.playSong;
    const entry = nativeLocalEntry(song.id);
    const target: LocalArtworkTarget | undefined =
      owner && song.path && entry
        ? {
            owner,
            songID: song.id,
            platform: song.platform,
            relativePath: song.path,
            ref: { ...entry.ref },
          }
        : undefined;
    const previousEntry = desiredEntry;
    desiredEntry = entry;
    const next = target && current(target) ? target : undefined;
    if (sameTarget(desired, next) && previousEntry === entry) return;
    desired = next;
    // A rescan can keep the same audio ref while replacing a sidecar. Reset
    // the session generation so both its ref dedup and any old read are fenced.
    session.update(undefined);
    if (disposed || desired !== next || desiredEntry !== entry) return;
    theme("");
    if (!disposed && desired === next && desiredEntry === entry) session.update(next);
  };
  const stop = watch(
    () => {
      const owner = filesSession.value;
      const song = music.playSong;
      const entry = nativeLocalEntry(song.id);
      return [
        ownsLocalArtworkReader(reader),
        owner,
        owner?.ready.value,
        owner?.directories.value,
        song.id,
        song.platform,
        song.path,
        entry,
        entry?.relativePath,
        entry?.ref.grantToken,
        entry?.ref.relativePath,
        entry?.ref.fileId,
        entry?.ref.version,
      ];
    },
    update,
    { immediate: true, flush: "sync" },
  );
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      session.dispose();
      if (desired) theme("");
      desired = undefined;
      desiredEntry = undefined;
      release();
    },
  };
}
