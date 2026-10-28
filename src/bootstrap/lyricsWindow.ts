import { createApp } from "vue";
import DesktopLyric from "@/views/DesktopLyric/index.vue";
import i18n from "@/i18n";
import "@/style/main.scss";
import "@/style/animate.scss";
import "@/style/desktopLyrics.scss";

/** 子页不加载主 App、路由、Pinia 持久化、音频或主窗口原生会话。 */
export function mountLyricsWindow(): void {
  document.documentElement.classList.add("desktop-lyrics-window");
  createApp(DesktopLyric).use(i18n).mount("#app");
}
