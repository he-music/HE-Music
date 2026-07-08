import { createApp } from "vue";
import App from "./App.vue";
// pinia
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
// vue-dompurify-html
import VueDOMPurifyHTML from "vue-dompurify-html";
// go-captcha
import GoCaptcha from "go-captcha-vue";
// router
import router from "@/router";
// 自定义指令
import { debounceDirective, throttleDirective, visibleDirective } from "@/utils/instruction";
// ipc
import initIpc from "@/utils/initIpc";
import i18n from "@/i18n";
// 全局样式
import "@/style/main.scss";
import "@/style/animate.scss";

// 挂载
const app = createApp(App);
// pinia
const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);
app.use(pinia);
// router
app.use(router);
// vue-dompurify-html
app.use(VueDOMPurifyHTML);
// go-captcha
app.use(GoCaptcha);
// i18n
app.use(i18n);
// 自定义指令
app.directive("debounce", debounceDirective);
app.directive("throttle", throttleDirective);
app.directive("visible", visibleDirective);
// app
app.mount("#app");

// 初始化 ipc
if (!location.hash.includes("desktop-lyric")) initIpc();
