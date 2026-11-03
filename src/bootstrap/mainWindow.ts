import { createApp } from "vue";
import App from "../App.vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { persistStatus } from "@/stores/persistStatus";
import VueDOMPurifyHTML from "vue-dompurify-html";
import GoCaptcha from "go-captcha-vue";
import router from "@/router";
import { debounceDirective, throttleDirective, visibleDirective } from "@/utils/instruction";
import { touchContextMenuDirective } from "@/utils/touchContextMenu";
import i18n from "@/i18n";
import "@/style/main.scss";
import "@/style/animate.scss";

/** 主窗口保留原有插件和路由初始化顺序。 */
export function mountMainWindow(): void {
  const app = createApp(App);
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  pinia.use(persistStatus);
  app.use(pinia);
  app.use(router);
  app.use(VueDOMPurifyHTML);
  app.use(GoCaptcha);
  app.use(i18n);
  app.directive("debounce", debounceDirective);
  app.directive("throttle", throttleDirective);
  app.directive("visible", visibleDirective);
  app.directive("touch-context-menu", touchContextMenuDirective);
  app.mount("#app");
}
