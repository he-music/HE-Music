import { createRouter, createWebHashHistory, Router } from "vue-router";
import { openUserLogin } from "@/utils/modal";
import { isElectron } from "@/utils/env";
import { isLogin } from "@/utils/auth";
import routes from "./routes";
import { usePlatformStore } from "@/stores";
import { t } from "@/i18n";

// 基础配置
const router: Router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes,
  // 保留滚动
  // scrollBehavior(to, _, savedPosition) {
  //   if (savedPosition) {
  //     return new Promise((resolve) => {
  //       setTimeout(() => {
  //         resolve(savedPosition);
  //       }, 300);
  //     });
  //   } else if (to.hash) {
  //     return {
  //       el: to.hash,
  //       behavior: "smooth",
  //     };
  //   } else {
  //     return { top: 0, left: 0, behavior: "smooth" };
  //   }
  // },
});

// 前置守卫
router.beforeEach(async (to, from, next) => {
  // console.log("前置守卫", to, from);
  // 进度条
  if (!isElectron && to.path !== from.path) {
    window.$loadingBar.start();
  }
  const platformStore = usePlatformStore();
  if (!to.meta.offline && !platformStore.platforms.length) {
    try {
      await platformStore.loadPlatforms();
    } catch (error) {
      console.error(error);
      if (!isElectron) window.$loadingBar.error();
    }
  }
  // 需要登录
  if (to.meta.needLogin && !isLogin()) {
    if (!isElectron) window.$loadingBar.error();
    window.$message.warning(t("message.login_required"));
    openUserLogin();
    return;
  }
  // 需要客户端
  else if (to.meta.needApp && !isElectron) {
    window.$message.warning(t("message.client_only_function"));
    next("/403");
    return;
  }
  next();
});

// 后置守卫
router.afterEach(() => {
  // 进度条
  window.$loadingBar.finish();
});

export default router;
