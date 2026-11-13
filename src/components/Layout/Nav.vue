<template>
  <n-layout-header class="nav" :data-mygo-borderless="nativeBorderless || undefined">
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
    <n-flex v-if="showWindowControls" align="center" class="client-control">
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
          <n-button
            v-if="platform.capabilities.tray"
            type="primary"
            strong
            secondary
            @click="hideOrClose('hide')"
          >
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
import { openLink, renderIcon } from "@/utils/helper";
import { isMac } from "@/utils/env";
import { platform } from "@/platform";
import { openParseSourceUrl, openSetting, openThemeConfig } from "@/utils/modal";
import { MOBILE_APP_RELEASE_URL } from "@/constants/links";
import { useI18n } from "vue-i18n";
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useMobile } from "@/composables/useMobile";
import Menu from "@/components/Layout/Menu.vue";
import { windowAppearanceSession } from "@/platform/windowAppearance";
import Logo from "@/components/Layout/Logo.vue";
import { useDesktopLifecycle } from "@/composables/useDesktopLifecycle";

const { t } = useI18n();

const router = useRouter();
const settingStore = useSettingStore();
const { isDesktopLayout: isDesktop, isSmallScreen } = useMobile();

const showCloseModal = ref(false);
// 是否记住
const rememberNotAsk = ref(false);
const desktopLifecycle = useDesktopLifecycle({ showCloseModal, rememberNotAsk });
// A failed optional appearance read must not hide controls on an already frameless window.
const nativeBorderless = computed(
  () =>
    platform.kind === "mygo" &&
    (windowAppearanceSession.value?.state.value?.appliedUseBorderless ?? true),
);
const showWindowControls = computed(
  () => platform.capabilities.windowControls && !isMac && nativeBorderless.value,
);
// 当前窗口状态
const isMax = ref(false);
// 是否显示侧边栏
const showAside = ref(false);
// 最小化
const min = () => void platform.window?.minimize().catch(console.error);

// 最大化或还原
const maxOrRes = () => void platform.window?.toggleMaximize().catch(console.error);

// 隐藏或关闭
const hideOrClose = (action: "hide" | "exit") => {
  if (platform.lifecycle) {
    void desktopLifecycle.resolveClose(action);
    return;
  }
  showCloseModal.value = false;
  void platform.window?.close().catch(console.error);
};

// 尝试关闭软件
const tryClose = () => {
  if (platform.lifecycle) {
    // Native close owns the request ID, prompt policy and final resolution.
    void platform.window?.close().catch(console.error);
    return;
  }
  if (!platform.capabilities.tray) {
    void platform.window?.close().catch(console.error);
    return;
  }
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
    show: platform.capabilities.windowControls,
    props: { onClick: () => void platform.window?.reload().catch(console.error) },
    icon: renderIcon("Restart"),
  },
  {
    key: "parse-source-url",
    label: t("nav.parse_source_url"),
    icon: renderIcon("Parse"),
  },
  {
    key: "mobile-app",
    label: t("nav.download_mobile_app"),
    icon: renderIcon("Phone"),
  },
  {
    key: "divider-2",
    type: "divider",
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
    case "parse-source-url":
      openParseSourceUrl();
      break;
    case "mobile-app":
      openLink(MOBILE_APP_RELEASE_URL);
      break;
    default:
      break;
  }
};

let stopMaximized = () => {};
let disposed = false;

onMounted(async () => {
  if (platform.window) {
    stopMaximized = platform.window.onMaximized((value) => {
      isMax.value = value;
    });
  }
  try {
    const maximized = await platform.window?.isMaximized();
    if (!disposed) isMax.value = maximized ?? false;
  } catch (error) {
    console.error("获取窗口状态失败：", error);
  }
});

onUnmounted(() => {
  disposed = true;
  stopMaximized();
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
  &[data-mygo-borderless] {
    --app-region: drag;
  }
  .page-control {
    --app-region: no-drag;
  }
  .n-button {
    width: 40px;
    height: 40px;
    -webkit-app-region: no-drag;
    --app-region: no-drag;
  }
  .nav-main {
    position: relative;
    flex: 1;
    align-items: center;
    height: 100%;
    margin-left: 12px;
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
