import { useMusicStore, useShortcutStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { platform } from "@/platform";
import { ShortcutSession } from "@/platform/shortcutSession";
import { useI18n } from "vue-i18n";

export function createShellShortcutSession(): ShortcutSession | undefined {
  const provider = platform.shortcuts;
  if (!provider) return;
  const store = useShortcutStore();
  const music = useMusicStore();
  const player = usePlayer();
  const { t } = useI18n();
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
