import { useShortcutStore } from "@/stores";
import { computed, markRaw } from "vue";
import ShortcutRecorder from "../components/ShortcutRecorder.vue";
import { snakeCase } from "lodash-es";
import { t } from "@/i18n";
import { SettingConfig, SettingItem } from "@/types/settings";
import { isElectron } from "@/utils/env";

export const useKeyboardSettings = (): SettingConfig => {
  const shortcutStore = useShortcutStore();

  const updateGlobalOpen = async (val: boolean) => {
    if (val) {
      await shortcutStore.registerAllShortcuts();
    } else {
      window.electron.ipcRenderer.send("unregister-all-shortcut");
      // 清除状态
      for (const key in shortcutStore.shortcutList) {
        shortcutStore.shortcutList[key as keyof typeof shortcutStore.shortcutList].isRegistered =
          false;
      }
    }
    shortcutStore.globalOpen = val;
  };

  const createShortcutItems = (filterKeys: string[], allowGlobal: boolean): SettingItem[] => {
    return Object.entries(shortcutStore.shortcutList)
      .filter(([key]) => filterKeys.includes(key))
      .map(([key]) => ({
        key,
        label: t("common." + snakeCase(key)),
        type: "custom",
        component: markRaw(ShortcutRecorder),
        componentProps: { shortcutKey: key, allowGlobal },
      }));
  };

  // 页面快捷键的 Key
  const pageShortcutKeys = Object.keys(shortcutStore.shortcutList).filter(
    (shortcut) => !isElectron || shortcutStore.shortcutList[shortcut].isPageShortcut,
  );
  // 全局快捷键的 Key
  const globalShortcutKeys = Object.keys(shortcutStore.shortcutList).filter(
    (shortcut) => isElectron && !shortcutStore.shortcutList[shortcut].isPageShortcut,
  );

  return {
    groups: [
      {
        title: t("setting.shortcut.global_shortcut"),
        show: isElectron,
        items: [
          {
            key: "globalOpen",
            label: t("setting.shortcut.open_global_shortcut"),
            type: "switch",
            description: t("setting.shortcut.open_global_shortcut_tip"),
            value: computed({
              get: () => shortcutStore.globalOpen,
              set: (v) => updateGlobalOpen(v),
            }),
          },
        ],
      },
      {
        show: isElectron,
        title: t("setting.shortcut.global_shortcut"),
        items: createShortcutItems(globalShortcutKeys, true),
      },
      {
        title: t("setting.shortcut.page_shortcut"),
        items: createShortcutItems(pageShortcutKeys, false),
      },
      {
        title: t("common.reset_default"),
        items: [
          {
            key: "resetShortcut",
            label: t("common.reset_default"),
            type: "button",
            buttonLabel: t("common.reset_default"),
            action: () => {
              window.$dialog.warning({
                title: t("setting.shortcut.reset"),
                content: t("message.shortcut_reset_confirm"),
                positiveText: t("common.reset"),
                negativeText: t("common.cancel"),
                onPositiveClick: () => {
                  shortcutStore.$reset();
                  window.$message.success(t("message.shortcut_reset_success"));
                },
              });
            },
          },
        ],
      },
    ],
  };
};
