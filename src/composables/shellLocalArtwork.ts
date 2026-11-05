import { computed, watch } from "vue";
import { platform } from "@/platform";
import { useMusicStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { filesSession } from "@/platform/filesSession";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import { localResourceURL } from "@/platform/localResource";
import { installLocalArtworkReader, ownsLocalArtworkReader } from "@/platform/localArtwork";

interface ArtworkDependencies {
  onTheme?: (url: string) => void | Promise<void>;
}

export function createShellLocalArtworkSession(deps: ArtworkDependencies = {}) {
  if (platform.kind !== "mygo" || !platform.files) return;
  const music = useMusicStore();
  const url = computed(() => {
    const song = music.playSong;
    const owner = filesSession.value;
    const entry = nativeLocalEntry(song.id);
    if (
      !owner?.ready.value ||
      !song.path ||
      !entry ||
      entry.relativePath !== song.path ||
      !owner.directories.value.some((grant) => grant.token === entry.ref.grantToken)
    )
      return undefined;
    return localResourceURL("artwork", entry);
  });
  const reader = (songID: string, source: string, path: string) => {
    const song = music.playSong;
    return song.id === songID && song.platform === source && song.path === path
      ? url.value
      : undefined;
  };
  const release = installLocalArtworkReader(reader);
  const onTheme = deps.onTheme ?? ((value: string) => usePlayer().updateArtworkTheme(value));
  const stop = watch(
    url,
    (value) => {
      if (!ownsLocalArtworkReader(reader)) return;
      void Promise.resolve()
        .then(() => {
          if (ownsLocalArtworkReader(reader) && url.value === value) return onTheme(value ?? "");
        })
        .catch(() => {});
    },
    { immediate: true, flush: "sync" },
  );
  return {
    dispose() {
      stop();
      release();
    },
  };
}
