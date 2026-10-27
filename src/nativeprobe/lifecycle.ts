// Development-only module imported explicitly by the isolated lifecycleprobe executable.
import { nextTick } from "vue";
import { platform } from "@/platform";
import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { t } from "@/i18n";

export async function prepareLifecycleProbe() {
  if (!import.meta.env.DEV || platform.kind !== "mygo" || !platform.lifecycle) {
    throw new Error("lifecycle probe requires isolated development mygo");
  }
  const settings = useSettingStore();
  const music = useMusicStore();
  const status = useStatusStore();
  const player = usePlayer();
  const previous = {
    showCloseAppTip: settings.showCloseAppTip,
    closeAppMethod: settings.closeAppMethod,
    song: music.playSong,
    playing: status.playStatus,
    toggle: player.playOrPause,
    next: player.nextOrPrev,
  };
  const calls: string[] = [];
  player.playOrPause = async () => {
    calls.push("toggle");
  };
  player.nextOrPrev = async (direction = "next") => {
    calls.push(direction);
  };
  music.playSong = {
    id: "lifecycle-synthetic",
    platform: "nativeprobe",
    name: "Lifecycle synthetic",
    subtitle: "Lifecycle synthetic",
    artists: "Probe",
    album: "Probe",
    duration: 16000,
    mv_id: "",
    cover: "/images/song.jpg",
    links: [],
  };
  settings.showCloseAppTip = true;
  settings.closeAppMethod = "exit";
  await nextTick();
  const prompt = () =>
    [...document.querySelectorAll<HTMLElement>(".n-modal")].find((element) =>
      element.textContent?.includes(t("nav.close_software")),
    );
  return {
    installed: () => platform.capabilities.tray,
    promptVisible: () => Boolean(prompt()?.getBoundingClientRect().height),
    cancel() {
      const close = prompt()?.querySelector<HTMLElement>(".n-base-close");
      if (!close) throw new Error("close prompt cancel control missing");
      close.click();
    },
    choose(action: "exit" | "hide", remember = false) {
      const modal = prompt();
      if (!modal) throw new Error("close prompt missing");
      if (remember) {
        const checkbox = modal.querySelector<HTMLElement>(".n-checkbox");
        if (!checkbox) throw new Error("remember control missing");
        checkbox.click();
      }
      const label = t(action === "hide" ? "nav.hide_to_tray" : "common.close");
      const button = [...modal.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === label,
      );
      if (!button) throw new Error("close prompt choice missing");
      button.click();
    },
    remembered: () => !settings.showCloseAppTip && settings.closeAppMethod === "hide",
    calls: () => [...calls],
    async teardown() {
      await platform.lifecycle?.teardown();
      return !platform.capabilities.tray;
    },
    async cleanup() {
      player.playOrPause = previous.toggle;
      player.nextOrPrev = previous.next;
      music.playSong = previous.song;
      status.playStatus = previous.playing;
      settings.showCloseAppTip = previous.showCloseAppTip;
      settings.closeAppMethod = previous.closeAppMethod;
      await nextTick();
    },
  };
}
