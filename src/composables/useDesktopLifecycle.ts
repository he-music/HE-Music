import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingStore, useStatusStore } from "@/stores";
import { platform } from "@/platform";
import type { CloseResolution, LifecycleConfig } from "@/platform/mygo.bindings";
import { createShellShortcutSession } from "./shellShortcuts";
import { createShellSystemMediaSession } from "./shellSystemMedia";
import { createFilesSession } from "@/platform/filesSession";
import { blockLocalAudio } from "@/platform/localAudioSession";
import { createShellDesktopLyricsSession } from "./shellDesktopLyrics";
import { desktopLyricsSession } from "@/platform/desktopLyricsSession";
import { createShellUpdatesSession } from "./shellUpdates";
import { createShellTraySession } from "./shellTray";
import { createShellLocalArtworkSession } from "./shellLocalArtwork";
// Serialize shell replacements so an old teardown cannot revoke a newly mounted owner.
let shellTransition: Promise<void> = Promise.resolve();

export function useDesktopLifecycle(ui: {
  showCloseModal: Ref<boolean>;
  rememberNotAsk: Ref<boolean>;
}) {
  const lifecycle = platform.lifecycle;
  const shortcuts = createShellShortcutSession();
  const media = platform.lifecycle ? createShellSystemMediaSession() : undefined;
  const files = lifecycle
    ? createFilesSession(platform.files, { blockAudio: blockLocalAudio })
    : undefined;
  const lyrics = lifecycle ? createShellDesktopLyricsSession() : undefined;
  const artwork = lifecycle ? createShellLocalArtworkSession() : undefined;
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
  const tray = createShellTraySession(lifecycle, {
    reportPlaybackFailure: () => {
      console.error("托盘播放操作失败");
      window.$message?.error(t("message.song_play_fail"));
    },
  });
  const updates = createShellUpdatesSession(() => setting.checkUpdateOnStart);
  const { t } = useI18n();
  let disposed = false;
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
      addToFavorites: t("common.add_to_favorites"),
      removeFromFavorites: t("common.remove_from_favorites"),
      repeat: t("common.play_mode_repeat"),
      repeatOnce: t("common.play_mode_repeat_once"),
      shuffle: t("common.play_mode_shuffle"),
      quit: t("nav.quit_app"),
    },
  });

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
          lifecycle.onTrayAction(tray.handle),
        );
        const nativeStatus = await lifecycle.ready(config());
        if (disposed) return;
        await tray.start(nativeStatus.epoch);
        void updates?.start().catch(() => console.error("应用更新会话初始化或检查失败"));
        void files?.start();
        await shortcuts?.start();
        await media?.start();
        if (disposed) return;
        void lyrics?.start().catch(() => console.error("桌面歌词会话初始化失败"));
        stops.push(
          watch(
            () => [setting.showCloseAppTip, setting.closeAppMethod, setting.language],
            () => void lifecycle.syncConfig(config()).catch(reportFailure),
          ),
        );
      } catch {
        reportFailure();
        tray.dispose();
        artwork?.dispose();
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
    artwork?.dispose();
    const updatesCleanup = updates?.dispose();
    const lyricsCleanup = lyrics?.dispose();
    const shortcutCleanup = shortcuts?.dispose();
    const mediaCleanup = media?.dispose();
    const filesCleanup = files?.dispose();
    tray.dispose();
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
