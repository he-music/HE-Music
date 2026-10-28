import { watch } from "vue";
import { useDataStore, useMusicStore, useStatusStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { createPlaybackSongSnapshot } from "@/utils/song";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import { TrayPlaybackSession, type TrayPlaybackSource } from "@/platform/trayPlaybackSession";
import type { PlatformLifecycle } from "@/platform/types";
import type { TrayRequest } from "@/platform/mygo.bindings";
import type { SongInfo } from "@/types/main.hemusic";

type Favorite = (song: SongInfo, desired: boolean) => Promise<void> | undefined;
interface TrayDependencies {
  player?: Pick<ReturnType<typeof usePlayer>, "playOrPause" | "nextOrPrev" | "togglePlayMode">;
  loadFavorite?: () => Promise<Favorite>;
  loadSettings?: () => Promise<() => unknown>;
  reportFailure?: () => void;
  reportPlaybackFailure?: () => void;
}

export const createShellTraySession = (
  provider: Pick<PlatformLifecycle, "syncPlayback">,
  dependencies: TrayDependencies = {},
) => {
  const data = useDataStore();
  const music = useMusicStore();
  const status = useStatusStore();
  const player = dependencies.player ?? usePlayer();
  const loadFavorite =
    dependencies.loadFavorite ?? (async () => (await import("@/utils/auth")).toLikeSong);
  const loadSettings =
    dependencies.loadSettings ?? (async () => (await import("@/utils/modal")).openSetting);
  const report = dependencies.reportFailure ?? (() => console.error("托盘操作失败"));
  const session = new TrayPlaybackSession(provider, report);
  let disposed = false;
  let favoriteBusy = false;
  let modeBusy = false;
  let sourceStamp = Symbol();
  let trackStamp = Symbol();
  const stops: Array<() => void> = [];

  const usable = () =>
    Boolean(
      music.playSong?.id &&
      music.playSong.platform &&
      (!music.playSong.path || nativeLocalEntry(music.playSong.id)),
    );
  const source = (includeBusy = true): TrayPlaybackSource => {
    const song = music.playSong;
    const key = usable() ? JSON.stringify([song.platform, song.id]) : "";
    const hasSong = Boolean(key && new TextEncoder().encode(key).byteLength <= 512);
    const mode = status.playSongMode;
    return {
      trackKey: hasSong ? key : "",
      hasSong,
      playing: hasSong && status.playStatus,
      liked: hasSong && data.isLikeSong(song),
      canFavorite: hasSong && data.userLoginStatus && !song.path && (!includeBusy || !favoriteBusy),
      playMode: mode === "shuffle" || mode === "repeat-once" ? mode : "repeat",
      canSetMode: hasSong && !status.radioMode && (!includeBusy || !modeBusy),
    };
  };
  const publish = () => {
    if (!disposed) session.update(source());
  };
  stops.push(
    watch(
      () => [
        music.playSong,
        music.playSong?.id,
        music.playSong?.platform,
        music.playSong?.path,
        usable(),
        status.radioMode,
      ],
      () => {
        trackStamp = Symbol();
      },
      { flush: "sync" },
    ),
    // 外部模式 A→B→A 也必须废弃异步恢复计划；监听归属长期主壳。
    watch(
      () => status.playSongMode,
      () => {
        data.playbackRevision = Symbol("playback");
      },
      { flush: "sync" },
    ),
    watch(
      [
        () => music.playSong,
        () => music.playSong?.path,
        () => JSON.stringify(source(false)),
        () => status.radioMode,
        () => data.userLoginStatus,
        () => data.userData.id,
        () => data.playbackRevision,
      ],
      () => {
        sourceStamp = Symbol();
        publish();
      },
      { immediate: true, flush: "sync" },
    ),
  );

  const handle = (request: TrayRequest) => {
    const intent = session.capture(request);
    if (!intent || disposed) return;
    const stamp = sourceStamp;
    const current = () => !disposed && session.ready && sourceStamp === stamp;
    switch (intent.action) {
      case "open-settings":
        void loadSettings()
          .then((open) => {
            if (current()) return open();
          })
          .catch(() => {
            if (current()) report();
          });
        return;
      case "set-favorite": {
        if (favoriteBusy || typeof intent.favorite !== "boolean") return;
        const captured = createPlaybackSongSnapshot(music.playSong);
        const desired = intent.favorite;
        favoriteBusy = true;
        publish();
        void (async () => {
          const favorite = await loadFavorite();
          if (current() && data.userLoginStatus && !captured.path)
            await favorite(captured, desired);
        })()
          .catch(() => {
            if (current()) report();
          })
          .finally(() => {
            if (disposed) return;
            favoriteBusy = false;
            publish();
          });
        return;
      }
      case "set-play-mode": {
        if (modeBusy || !intent.mode) return;
        const track = trackStamp;
        const modeCurrent = () =>
          !disposed && session.ready && trackStamp === track && usable() && !status.radioMode;
        modeBusy = true;
        publish();
        void player
          .togglePlayMode(intent.mode, modeCurrent)
          .catch(() => {
            if (modeCurrent()) report();
          })
          .finally(() => {
            if (disposed) return;
            modeBusy = false;
            publish();
          });
        return;
      }
      case "toggle":
      case "previous":
      case "next":
        if (!current() || !usable()) return;
        void (
          intent.action === "toggle"
            ? player.playOrPause()
            : player.nextOrPrev(intent.action === "previous" ? "prev" : "next")
        ).catch(() => {
          if (current()) (dependencies.reportPlaybackFailure ?? report)();
        });
        return;
    }
  };
  return {
    start: (epoch: number) => session.start(epoch),
    handle,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      session.dispose();
      stops.splice(0).forEach((stop) => stop());
    },
  };
};
