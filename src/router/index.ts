import { createRouter, createWebHashHistory, Router } from "vue-router";
import { openUserLogin } from "@/utils/modal";
import { isElectron } from "@/utils/env";
import { isLogin } from "@/utils/auth";
import routes from "./routes";
import { usePlatformStore, useStatusStore } from "@/stores";
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
router.beforeEach((to, from, next) => {
  // console.log("前置守卫", to, from);
  // 进度条
  if (!isElectron && to.path !== from.path) {
    window.$loadingBar?.start();
  }
  const platformStore = usePlatformStore();

  // 需要登录
  if (to.meta.needLogin && !isLogin()) {
    if (!isElectron) window.$loadingBar?.error();
    window.$message?.warning(t("message.login_required"));
    openUserLogin();
    next(false);
    return;
  }
  // 需要客户端
  if (to.meta.needApp && !isElectron) {
    window.$message?.warning(t("message.client_only_function"));
    next("/403");
    return;
  }

  // 后台加载平台信息，让主框架先渲染。
  if (!to.meta.offline && !platformStore.platforms.length) {
    void platformStore.loadPlatforms().catch((error) => {
      console.error("加载平台列表失败：", error);
      if (!isElectron) window.$loadingBar?.error();
    });
  }

  next();
});

// 后置守卫
router.afterEach(() => {
  // 进度条
  window.$loadingBar?.finish();

  // 以搜索路由为准同步搜索框，确保所有搜索入口及前进、后退行为一致
  const currentRoute = router.currentRoute.value;
  const keyword = currentRoute.query.keyword;
  if (currentRoute.name === "search" && typeof keyword === "string") {
    useStatusStore().searchInputValue = keyword;
  }
});

export default router;
