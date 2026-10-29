import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { filesSession } from "@/platform/filesSession";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import { desktopLyricsSession } from "@/platform/desktopLyricsSession";
import {
  TaskbarSession,
  type TaskbarLabels,
  type TaskbarProvider,
} from "@/platform/taskbarSession";
import { createShellShortcutActions } from "./shellShortcutActions";

export interface TaskbarShellSource {
  track(): unknown;
  enabled(): boolean;
  playing(): boolean;
  positionMs(): number;
  durationMs(): number;
  labels(): TaskbarLabels;
}

/** Only this consumer watches the playback clock; quantization suppresses subsecond sends. */
export function createTaskbarShellConsumer(session: TaskbarSession, source: TaskbarShellSource) {
  let disposed = false;
  let stop: (() => void) | undefined;
  const labels = computed(source.labels);
  const duration = () => Math.max(0, Math.floor(source.durationMs()));
  const position = () => Math.floor(Math.max(0, source.positionMs()) / 1000) * 1000;
  return {
    async start() {
      await session.start();
      if (disposed || stop) return;
      stop = watch(
        [source.track, source.enabled, source.playing, position, duration, () => labels.value],
        () => {
          void session.sync({
            enabled: source.enabled(),
            playing: source.playing(),
            positionMs: Math.min(position(), duration()),
            durationMs: duration(),
            labels: labels.value,
          });
        },
        { immediate: true, flush: "sync" },
      );
    },
    dispose() {
      disposed = true;
      stop?.();
      stop = undefined;
      return session.dispose();
    },
  };
}

/** Parent calls start after lifecycle Ready; pass the optional Windows mygo provider. */
export function createShellTaskbarSession(provider: TaskbarProvider | undefined) {
  if (!provider) return;
  const music = useMusicStore();
  const setting = useSettingStore();
  const status = useStatusStore();
  const player = usePlayer();
  const { t } = useI18n();
  const actions = createShellShortcutActions({
    owner: () => session.executionToken,
    song: () => music.playSong,
    files: () => filesSession.value,
    localEntry: nativeLocalEntry,
    lyrics: () => desktopLyricsSession.value,
    player,
    reportFailure: () => window.$message?.error(t("message.song_play_fail")),
  });
  const session = new TaskbarSession(
    provider,
    (action) => {
      void actions.handle(
        action === "previous" ? "playPrev" : action === "next" ? "playNext" : "playOrPause",
      );
    },
    () => window.$message?.error(t("mygo.taskbar.failed")),
  );
  const consumer = createTaskbarShellConsumer(session, {
    track: () => music.playSong,
    enabled: () => setting.showTaskbarProgress,
    playing: () => status.playStatus,
    positionMs: () => status.currentTime,
    durationMs: () => status.duration,
    labels: () => ({
      previous: t("common.play_prev"),
      play: t("common.play"),
      pause: t("common.pause"),
      next: t("common.play_next"),
    }),
  });
  return {
    start: consumer.start,
    dispose() {
      actions.dispose();
      return consumer.dispose();
    },
  };
}
