import { useDataStore, useSettingStore } from "@/stores";
import { isElectron } from "@/utils/env";
import { SettingConfig } from "@/types/settings";
import { computed } from "vue";
import { t } from "@/i18n";
import { platform } from "@/platform";
import type { GeneralSettingsActions } from "./generalActions";

export const useGeneralSettings = (actions: GeneralSettingsActions): SettingConfig => {
  const dataStore = useDataStore();
  const settingStore = useSettingStore();

  // 任务栏进度
  const closeTaskbarProgress = (val: boolean) => {
    if (!isElectron) return;
    if (!val) window.electron.ipcRenderer.send("set-bar", "none");
  };

  // 重置设置
  const resetSetting = () => {
    if (platform.kind === "mygo") {
      if (actions.disabled.value) return;
      return actions.preferencesReset.request("settings");
    }
    window.$dialog.warning({
      title: t("common.warning"),
      content: t("message.reset_setting_confirm"),
      positiveText: t("common.ok"),
      negativeText: t("common.cancel"),
      onPositiveClick: () => {
        settingStore.$reset();
        // electron
        if (isElectron) window.electron.ipcRenderer.send("reset-setting");
        window.$message.success(t("message.reset_setting_success"));
      },
    });
  };

  // 清除全部数据
  const clearAllData = () => {
    if (platform.kind === "mygo") {
      if (actions.disabled.value) return;
      return actions.preferencesReset.request("all");
    }
    window.$dialog.warning({
      title: t("common.warning"),
      content: t("message.clear_all_data_confirm"),
      positiveText: t("common.ok"),
      negativeText: t("common.cancel"),
      onPositiveClick: async () => {
        // 重置设置
        window.localStorage.clear();
        window.sessionStorage.clear();
        // deleteDB
        await dataStore.deleteDB();
        // electron
        if (isElectron) window.electron.ipcRenderer.send("reset-setting");
        window.$message.loading(t("message.clear_all_data_success"), {
          duration: 3000,
          onAfterLeave: () => window.location.reload(),
        });
      },
    });
  };

  return {
    groups: [
      {
        title: t("setting.general.system_behavior"),
        show: isElectron || platform.kind === "mygo",
        items: [
          {
            key: "closeAppMethod",
            label: t("setting.general.close_software"),
            type: "select",
            description: t("setting.general.close_software_tip"),
            disabled: computed(() => settingStore.showCloseAppTip || !platform.capabilities.tray),
            options: [
              {
                label: t("setting.general.close_software_value_hide"),
                value: "hide",
              },
              {
                label: t("setting.general.close_software_value_close"),
                value: "exit",
              },
            ],
            value: computed({
              get: () => settingStore.closeAppMethod,
              set: (v) => (settingStore.closeAppMethod = v),
            }),
          },
          {
            key: "showCloseAppTip",
            disabled: computed(() => !platform.capabilities.tray),
            label: t("setting.general.show_close_app_tip"),
            type: "switch",
            value: computed({
              get: () => settingStore.showCloseAppTip,
              set: (v) => (settingStore.showCloseAppTip = v),
            }),
          },
          {
            key: "showTaskbarProgress",
            show: isElectron || Boolean(platform.taskbar),
            label: t("setting.general.show_taskbar_progress"),
            type: "switch",
            description: t("setting.general.show_taskbar_progress_tip"),
            value: computed({
              get: () => settingStore.showTaskbarProgress,
              set: (v) => {
                settingStore.showTaskbarProgress = v;
                closeTaskbarProgress(v);
              },
            }),
          },
          {
            key: "registryProtocols",
            show: isElectron || Boolean(platform.protocols),
            label: t("setting.general.registry_protocols"),
            type: "select",
            options: [
              {
                label: t("platform.netease"),
                value: "orpheus",
              },
              {
                label: t("platform.kuwo"),
                value: "kuwo",
              },
            ],
            componentProps: {
              multiple: true,
            },
            description: t("setting.general.registry_protocols_tip"),
            value: computed({
              get: () => settingStore.registryProtocols,
              set: (v) => {
                settingStore.registryProtocols = v;
              },
            }),
          },
          {
            key: "checkUpdateOnStart",
            show: isElectron || Boolean(platform.updates),
            label: t("setting.general.check_update_on_start"),
            type: "switch",
            description: t("setting.general.check_update_on_start_tip"),
            value: computed({
              get: () => settingStore.checkUpdateOnStart,
              set: (v) => (settingStore.checkUpdateOnStart = v),
            }),
          },
        ],
      },
      {
        title: t("setting.general.search_setting"),
        items: [
          {
            key: "showSearchHistory",
            label: t("setting.general.show_search_history"),
            type: "switch",
            value: computed({
              get: () => settingStore.showSearchHistory,
              set: (v) => (settingStore.showSearchHistory = v),
            }),
          },
        ],
      },
      {
        title: t("setting.other.backup_and_restore"),
        tags: [{ text: "Beta", type: "warning" }],
        show: isElectron || Boolean(platform.files),
        items: [
          {
            key: "exportSettings",
            disabled: actions.disabled,
            label: t("setting.other.export_settings"),
            type: "button",
            description: t("setting.other.export_settings_tip"),
            buttonLabel: t("setting.other.export_settings"),
            action: actions.exportSettings,
            componentProps: { type: "primary" },
          },
          {
            key: "importSettings",
            disabled: actions.disabled,
            label: t("setting.other.import_settings"),
            type: "button",
            description: t("setting.other.import_settings_tip"),
            buttonLabel: t("setting.other.import_settings"),
            action: actions.importSettings,
            componentProps: { type: "primary" },
          },
        ],
      },
      {
        title: t("common.reset"),
        items: [
          {
            key: "resetSetting",
            label: t("setting.other.reset_setting"),
            type: "button",
            description: t("setting.other.reset_setting_tip"),
            buttonLabel: t("setting.other.reset_setting_btn"),
            action: resetSetting,
            disabled: platform.kind === "mygo" ? actions.resetDisabled : undefined,
            componentProps: { type: "warning" },
          },
          {
            key: "clearAllData",
            label: t("setting.other.clear_all_data"),
            type: "button",
            description: t("setting.other.clear_all_data_tip"),
            buttonLabel: t("setting.other.clear_all_data_btn"),
            action: clearAllData,
            disabled: platform.kind === "mygo" ? actions.resetDisabled : undefined,
            componentProps: { type: "error" },
          },
        ],
      },
    ],
  };
};
