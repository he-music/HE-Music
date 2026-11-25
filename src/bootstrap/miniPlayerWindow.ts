import { createApp } from "vue";
import i18n from "@/i18n";
import MiniPlayer from "@/views/MiniPlayer/index.vue";
import { removeStartupLoading } from "./startupLoading";

export function mountMiniPlayerWindow(): void {
  document.documentElement.classList.add("mini-player-window");
  createApp(MiniPlayer).use(i18n).mount("#app");
  removeStartupLoading();
}
