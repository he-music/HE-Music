import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { platform } from "@/platform";
import { usePlayer } from "@/utils/player";
import type { CloseResolution, LifecycleConfig } from "@/platform/mygo.bindings";
import { createShellShortcutSession } from "./shellShortcuts";
import { createShellSystemMediaSession } from "./shellSystemMedia";
import { createFilesSession } from "@/platform/filesSession";
import { createShellDesktopLyricsSession } from "./shellDesktopLyrics";
import { desktopLyricsSession } from "@/platform/desktopLyricsSession";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import { createShellUpdatesSession } from "./shellUpdates";
// Serialize shell replacements so an old teardown cannot revoke a newly mounted owner.
let shellTransition: Promise<void> = Promise.resolve();

export function useDesktopLifecycle(ui: {
  showCloseModal: Ref<boolean>;
  rememberNotAsk: Ref<boolean>;
}) {
  const lifecycle = platform.lifecycle;
  const shortcuts = createShellShortcutSession();
  const media = platform.lifecycle ? createShellSystemMediaSession() : undefined;
  const files = lifecycle ? createFilesSession(platform.files) : undefined;
  const lyrics = lifecycle ? createShellDesktopLyricsSession() : undefined;
  if (!lifecycle) {
    let disposed = false;
    onMounted(() => {
      shellTransition = shellTransition.then(async () => {
        if (!disposed) await shortcuts?.start();
      });
    });
    onBeforeUnmount(() => {
      disposed = true;
      const cleanup = shortcuts?.dispose();
      shellTransition = shellTransition.then(async () => {
        await cleanup;
      });
    });
    return { resolveClose: async () => {} };
  }

  const setting = useSettingStore();
  const status = useStatusStore();
  const music = useMusicStore();
  const player = usePlayer();
  const updates = createShellUpdatesSession(() => setting.checkUpdateOnStart);
  const { t } = useI18n();
  let disposed = false;
  let ready = false;
  let requestId: number | null = null;
  let acknowledgement: Promise<void> = Promise.resolve();
  const stops: Array<() => void> = [];
  if (lyrics) {
    stops.push(
      watch(
        () => {
          const session = desktopLyricsSession.value;
          return session?.ready.value === true && session.window.value?.visible === true;
        },
        (visible) => (status.showDesktopLyric = visible),
        { immediate: true, flush: "sync" },
      ),
    );
  }
  const subscriptions: Array<() => void> = [];
  const reportFailure = () => console.error("桌面生命周期操作失败");
  const config = (): LifecycleConfig => ({
    showCloseAppTip: setting.showCloseAppTip,
    closeAppMethod: setting.closeAppMethod === "hide" ? "hide" : "exit",
    labels: {
      show: t("nav.show_main_window"),
      hide: t("nav.hide_main_window"),
      showLyrics: t("nav.show_desktop_lyrics"),
      hideLyrics: t("nav.hide_desktop_lyrics"),
      lockLyrics: t("nav.lock_desktop_lyrics"),
      unlockLyrics: t("nav.unlock_desktop_lyrics"),
      settings: t("common.setting"),
      play: t("common.play"),
      pause: t("common.pause"),
      previous: t("common.play_prev"),
      next: t("common.play_next"),
      quit: t("nav.quit_app"),
    },
  });
  const hasSong = () =>
    Boolean(music.playSong?.id && (!music.playSong.path || nativeLocalEntry(music.playSong.id)));
  const syncPlayback = () =>
    lifecycle.syncPlayback({ playing: status.playStatus, hasSong: hasSong() });

  const resolve = async (resolution: CloseResolution) => {
    const remember = ui.rememberNotAsk.value;
    const id = requestId;
    if (id === null || disposed) return;
    requestId = null;
    ui.showCloseModal.value = false;
    try {
      await acknowledgement;
      if (disposed) return;
      if (resolution !== "cancel" && remember) {
        setting.closeAppMethod = resolution;
        setting.showCloseAppTip = false;
        await nextTick();
      }
      await lifecycle.resolveClose(id, resolution);
    } catch {
      reportFailure();
    }
  };

  onMounted(() => {
    shellTransition = shellTransition.then(async () => {
      if (disposed) return;
      try {
        subscriptions.push(
          lifecycle.onCloseRequested(({ requestId: id }) => {
            if (disposed || requestId !== null) return;
            requestId = id;
            ui.rememberNotAsk.value = false;
            ui.showCloseModal.value = true;
            acknowledgement = nextTick().then(async () => {
              if (disposed) return;
              await lifecycle.acknowledgeClose(id);
            });
            void acknowledgement.catch(() => {
              if (requestId === id) {
                requestId = null;
                ui.showCloseModal.value = false;
              }
              reportFailure();
            });
          }),
          lifecycle.onTrayAction((action) => {
            if (action === "open-settings") {
              if (!disposed && ready) {
                void import("@/utils/modal")
                  .then(async ({ openSetting }) => {
                    if (!disposed && ready) await openSetting();
                  })
                  .catch(reportFailure);
              }
              return;
            }
            if (disposed || !ready || !hasSong()) return;
            void (async () => {
              if (action === "toggle") await player.playOrPause();
              else await player.nextOrPrev(action === "previous" ? "prev" : "next");
            })().catch(() => {
              console.error("托盘播放操作失败");
              window.$message?.error(t("message.song_play_fail"));
            });
          }),
        );
        await lifecycle.ready(config());
        if (disposed) return;
        ready = true;
        void updates?.start().catch(() => console.error("应用更新会话初始化或检查失败"));
        void files?.start();
        await shortcuts?.start();
        await media?.start();
        await syncPlayback();
        if (disposed) return;
        void lyrics?.start().catch(() => console.error("桌面歌词会话初始化失败"));
        stops.push(
          watch(
            () => [setting.showCloseAppTip, setting.closeAppMethod, setting.language],
            () => void lifecycle.syncConfig(config()).catch(reportFailure),
          ),
          watch(
            () => [status.playStatus, music.playSong?.id, music.playSong?.platform, hasSong()],
            () => void syncPlayback().catch(reportFailure),
          ),
        );
      } catch {
        reportFailure();
        ready = false;
        await updates?.dispose();
        await lyrics?.dispose();
        await files?.dispose();
        await media?.dispose();
        await shortcuts?.dispose();
        await lifecycle.teardown().catch(reportFailure);
        subscriptions.splice(0).forEach((stop) => stop());
      }
    });
  });
  stops.push(
    watch(ui.showCloseModal, (show) => {
      if (!show && requestId !== null) void resolve("cancel");
    }),
  );
  onBeforeUnmount(() => {
    disposed = true;
    const updatesCleanup = updates?.dispose();
    const lyricsCleanup = lyrics?.dispose();
    const shortcutCleanup = shortcuts?.dispose();
    const mediaCleanup = media?.dispose();
    const filesCleanup = files?.dispose();
    ready = false;
    requestId = null;
    ui.showCloseModal.value = false;
    stops.splice(0).forEach((stop) => stop());
    shellTransition = shellTransition.then(async () => {
      await updatesCleanup;
      await lyricsCleanup;
      await shortcutCleanup;
      await mediaCleanup;
      await filesCleanup;
      await lifecycle.teardown().catch(reportFailure);
      subscriptions.splice(0).forEach((stop) => stop());
    });
  });
  return { resolveClose: (action: "hide" | "exit") => resolve(action) };
}
