import { nextTick } from "vue";
import { useShortcutStore } from "@/stores/shortcut";
import { shortcutSession } from "@/platform/shortcutSession";
import { usePlayer } from "@/utils/player";

/** Isolated-origin fixture: never reads the normal application's shortcut settings. */
export async function prepareShortcutProbe() {
  const store = useShortcutStore();
  const session = shortcutSession(store);
  if (!session) throw new Error("shortcut shell unavailable");
  const player = usePlayer();
  const originalVolume = player.setVolume;
  let callbacks = 0;
  player.setVolume = () => {
    callbacks++;
  };
  for (const item of Object.values(store.shortcutList)) item.globalShortcut = "";
  store.shortcutList.volumeUp.globalShortcut = "Ctrl+Alt+Shift+F19";
  store.globalOpen = true;
  await nextTick();
  await session.refresh();
  let token: symbol | undefined;
  return {
    registered: () => !store.shortcutList.volumeUp.isRegistered,
    async suspend() {
      token = session.beginRecording();
      await session.refresh();
      return true;
    },
    async resume() {
      if (token) await session.endRecording(token);
      token = undefined;
      return true;
    },
    callbacks: () => callbacks,
    async disable() {
      store.globalOpen = false;
      await session.refresh();
      return true;
    },
    async cleanup() {
      store.globalOpen = false;
      await session.dispose();
      player.setVolume = originalVolume;
      return true;
    },
  };
}
