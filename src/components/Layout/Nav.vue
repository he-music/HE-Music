<template>
  <n-layout-header class="nav">
    <!-- 页面导航 -->
    <n-flex class="page-control">
      <Logo v-if="!isDesktop" :size="40" @click="router.push('/')" />
      <template v-if="!isSmallScreen">
        <n-button :focusable="false" tertiary circle @click="router.go(-1)">
          <template #icon>
            <SvgIcon name="NavigateBefore" :size="26" />
          </template>
        </n-button>
        <n-button :focusable="false" tertiary circle @click="router.go(1)">
          <template #icon>
            <SvgIcon name="NavigateNext" :size="26" />
          </template>
        </n-button>
      </template>
    </n-flex>
    <!-- 主内容 -->
    <n-flex :wrap="false" justify="end" class="nav-main">
      <!-- 搜索 -->
      <SearchInp />
      <!-- 可拖拽 -->
      <div v-if="isDesktop" class="nav-drag" />

      <n-flex align="center">
        <!-- 用户 -->
        <User v-if="settingStore.useOnlineService" />
        <!-- 设置菜单 -->
        <n-dropdown :options="setOptions" trigger="click" show-arrow @select="setSelect">
          <n-button :focusable="false" :title="t('common.setting')" tertiary circle>
            <template #icon>
              <SvgIcon name="Settings" />
            </template>
          </n-button>
        </n-dropdown>
        <!-- 移动端菜单 -->
        <n-button
          v-if="!isDesktop"
          :focusable="false"
          tertiary
          circle
          @click="showAside = !showAside"
        >
          <template #icon>
            <SvgIcon name="Menu" />
          </template>
        </n-button>
        <n-drawer v-model:show="showAside" :width="240" placement="left">
          <n-drawer-content :body-content-style="{ padding: 0 }" :native-scrollbar="false">
            <template #header>
              <n-flex align="center" justify="center" class="aside-logo">
                <Logo />
                <n-text>HE-Music</n-text>
              </n-flex>
            </template>
            <Menu @menu-click="showAside = false" />
          </n-drawer-content>
        </n-drawer>
      </n-flex>
    </n-flex>
    <!-- 客户端控制 -->
    <n-flex v-if="isElectron && !isMac && !isSmallScreen" align="center" class="client-control">
      <n-divider class="divider" vertical />
      <n-button :focusable="false" :title="t('nav.minimize')" tertiary circle @click="min">
        <template #icon>
          <SvgIcon name="WindowMinimize" />
        </template>
      </n-button>
      <n-button
        :focusable="false"
        :title="isMax ? t('nav.restore') : t('nav.maximize')"
        tertiary
        circle
        @click="maxOrRes"
      >
        <template #icon>
          <SvgIcon :name="isMax ? 'WindowRestore' : 'WindowMaximize'" />
        </template>
      </n-button>
      <n-button :focusable="false" :title="t('common.close')" tertiary circle @click="tryClose">
        <template #icon>
          <SvgIcon name="WindowClose" />
        </template>
      </n-button>
    </n-flex>
    <!-- 关闭弹窗 -->
    <n-modal
      v-model:show="showCloseModal"
      :auto-focus="false"
      :title="t('nav.close_software')"
      style="width: 600px"
      preset="card"
      transform-origin="center"
      bordered
      @after-leave="rememberNotAsk = false"
    >
      <n-text class="tip">
        {{ t("message.close_software_confirm") }}
      </n-text>
      <n-checkbox v-model:checked="rememberNotAsk" class="checkbox">
        {{ t("message.remember_and_do_not_ask_again") }}
      </n-checkbox>
      <template #footer>
        <n-flex justify="end">
          <n-button strong secondary @click="hideOrClose('exit')">
            <template #icon>
              <SvgIcon name="ExitToApp" />
            </template>
            {{ t("common.close") }}
          </n-button>
          <n-button type="primary" strong secondary @click="hideOrClose('hide')">
            <template #icon>
              <SvgIcon name="WindowHide" />
            </template>
            {{ t("nav.hide_to_tray") }}
          </n-button>
        </n-flex>
      </template>
    </n-modal>
  </n-layout-header>
</template>

<script setup lang="ts">
import type { DropdownOption } from "naive-ui";
import { useSettingStore } from "@/stores";
import { renderIcon } from "@/utils/helper";
import { isDev, isElectron, isMac } from "@/utils/env";
import { openParseSourceUrl, openSetting, openThemeConfig } from "@/utils/modal";
import { useI18n } from "vue-i18n";
import { ref, onMounted, onUnmounted } from "vue";
import { useMobile } from "@/composables/useMobile";
import Menu from "@/components/Layout/Menu.vue";
import Logo from "@/components/Layout/Logo.vue";

const { t } = useI18n();

const router = useRouter();
const settingStore = useSettingStore();
const { isDesktop, isSmallScreen } = useMobile();

const showCloseModal = ref(false);
// 是否记住
const rememberNotAsk = ref(false);
// 是否启用无边框窗口
const useBorderless = ref(true);
// 当前窗口状态
const isMax = ref(false);
// 是否显示侧边栏
const showAside = ref(false);
// 最小化
const min = () => window.electron.ipcRenderer.send("win-min");

// 最大化或还原
const maxOrRes = () => {
  if (window.electron.ipcRenderer.sendSync("win-state")) {
    window.electron.ipcRenderer.send("win-restore");
  } else {
    window.electron.ipcRenderer.send("win-max");
  }
};

// 隐藏或关闭
const hideOrClose = (action: "hide" | "exit") => {
  if (rememberNotAsk.value) {
    settingStore.showCloseAppTip = false;
    settingStore.closeAppMethod = action;
  }
  showCloseModal.value = false;
  // 延迟执行，等待模态对话框关闭动画完成（150ms）
  window.electron.ipcRenderer.send(action === "hide" ? "win-hide" : "quit-app");
};

// 尝试关闭软件
const tryClose = () => {
  if (settingStore.showCloseAppTip) {
    showCloseModal.value = true;
  } else {
    hideOrClose(settingStore.closeAppMethod);
  }
};

// 设置菜单
const setOptions = computed<DropdownOption[]>(() => [
  {
    label:
      settingStore.themeMode === "auto"
        ? t("setting.general.theme_mode_value_light")
        : settingStore.themeMode === "light"
          ? t("setting.general.theme_mode_value_dark")
          : t("setting.general.theme_mode_value_auto"),
    key: "themeMode",
    icon: renderIcon(
      settingStore.themeMode === "auto"
        ? "LightTheme"
        : settingStore.themeMode === "light"
          ? "DarkTheme"
          : "AutoTheme",
    ),
  },
  {
    label: t("setting.general.theme_config"),
    key: "themeConfig",
    icon: renderIcon("Palette"),
  },
  {
    key: "divider-1",
    type: "divider",
  },
  {
    // 重启
    key: "restart",
    label: t("nav.software_hot_reload"),
    show: isElectron,
    props: { onClick: () => window.electron.ipcRenderer.send("win-reload") },
    icon: renderIcon("Restart"),
  },
  {
    key: "dev-tools",
    label: t("nav.open_dev_tool"),
    show: isElectron && isDev,
    icon: renderIcon("Code"),
  },
  {
    key: "parse-source-url",
    label: t("nav.parse_source_url"),
    icon: renderIcon("Parse"),
  },
  {
    key: "setting",
    label: t("nav.global_setting"),
    icon: renderIcon("Settings"),
  },
]);

// 菜单选择
const setSelect = (key: string) => {
  switch (key) {
    case "themeMode":
      settingStore.setThemeMode();
      break;
    case "themeConfig":
      openThemeConfig();
      break;
    case "setting":
      if (isSmallScreen.value) {
        router.push("/setting");
        return;
      }
      openSetting();
      break;
    case "dev-tools":
      window.electron.ipcRenderer.send("open-dev-tools");
      break;
    case "parse-source-url":
      openParseSourceUrl();
      break;
    default:
      break;
  }
};

onMounted(async () => {
  // 获取窗口状态并监听主进程的状态变更
  if (isElectron) {
    // 获取无边框窗口配置
    const windowConfig = await window.api.store.get("window");
    useBorderless.value = windowConfig?.useBorderless ?? true;
    isMax.value = window.electron.ipcRenderer.sendSync("win-state");
    window.electron.ipcRenderer.on("win-state-change", (_event, value: boolean) => {
      isMax.value = value;
    });
    // Mac 下点击原生关闭按钮时，触发关闭确认逻辑
    window.electron.ipcRenderer.on("win-close-triggered", () => {
      tryClose();
    });
  }
});

onUnmounted(() => {
  // 清理事件监听器
  if (isElectron) {
    window.electron.ipcRenderer.removeAllListeners("win-state-change");
    window.electron.ipcRenderer.removeAllListeners("win-close-triggered");
  }
});
</script>

<style lang="scss" scoped>
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 70px;
  padding: 0 1rem;
  background-color: transparent;
  -webkit-app-region: drag;
  .n-button {
    width: 40px;
    height: 40px;
    -webkit-app-region: no-drag;
  }
  .nav-main {
    position: relative;
    flex: 1;
    align-items: center;
    height: 100%;
    margin-left: 12px;
    .nav-drag {
      flex: 1;
      width: 100%;
      height: 100%;
    }
  }
  .client-control {
    .divider {
      margin: 0 0 0 12px;
    }
  }
}
.tip {
  font-size: 16px;
}
.aside-logo {
  .n-text {
    width: 90px;
    font-size: 18px;
    font-family: "logo";
    margin-top: 2px;
    line-height: 40px;
  }
}
.checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  width: max-content;
  margin-top: 12px;
  :deep(.n-checkbox__label) {
    line-height: 0;
  }
}
</style>
