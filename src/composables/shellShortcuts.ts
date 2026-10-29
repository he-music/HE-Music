import { useMusicStore, useShortcutStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { platform } from "@/platform";
import { ShortcutSession } from "@/platform/shortcutSession";
import { useI18n } from "vue-i18n";
import { filesSession } from "@/platform/filesSession";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import { desktopLyricsSession } from "@/platform/desktopLyricsSession";
import { createShellShortcutActions } from "./shellShortcutActions";

export function createShellShortcutSession():
  Pick<ShortcutSession, "start" | "dispose"> | undefined {
  const provider = platform.shortcuts;
  if (!provider) return;
  const store = useShortcutStore();
  const music = useMusicStore();
  const player = usePlayer();
  const { t } = useI18n();
  if (platform.kind === "mygo") {
    const identity = Symbol("shortcut shell");
    let owner: symbol | undefined;
    let disposed = false;
    const actions = createShellShortcutActions({
      owner: () => (owner === identity ? session.executionToken : undefined),
      song: () => music.playSong,
      files: () => filesSession.value,
      localEntry: nativeLocalEntry,
      lyrics: () => desktopLyricsSession.value,
      player,
      reportFailure: () => window.$message?.error(t("message.song_play_fail")),
    });
    const session = new ShortcutSession(
      store,
      provider,
      (action) => {
        void actions.handle(action);
      },
      () => window.$message?.warning(t("message.shortcut_registered_fail")),
      platform.os,
    );
    return {
      async start() {
        // ShortcutSession remains the sole native generation/recording owner.
        // Events cannot execute until the shell's Ready-gated start is called.
        if (disposed) return;
        owner = identity;
        await session.start();
      },
      dispose() {
        disposed = true;
        owner = undefined;
        actions.dispose();
        return session.dispose();
      },
    };
  }
  return new ShortcutSession(
    store,
    provider,
    (action) => {
      void (async () => {
        if (action === "volumeUp" || action === "volumeDown") {
          player.setVolume(action === "volumeUp" ? "up" : "down");
          return;
        }
        if (!music.playSong?.id || music.playSong.path) return;
        if (action === "playOrPause") await player.playOrPause();
        else await player.nextOrPrev(action === "playPrev" ? "prev" : "next");
      })().catch(() => window.$message?.error(t("message.song_play_fail")));
    },
    () => window.$message?.warning(t("message.shortcut_registered_fail")),
    platform.os,
  );
}
