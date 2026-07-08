import { useDataStore, useSettingStore } from "@/stores";
import { isElectron } from "@/utils/env";
import { SettingConfig } from "@/types/settings";
import { computed } from "vue";
import { t } from "@/i18n";

export const useGeneralSettings = (): SettingConfig => {
  const dataStore = useDataStore();
  const settingStore = useSettingStore();

  // 任务栏进度
  const closeTaskbarProgress = (val: boolean) => {
    if (!isElectron) return;
    if (!val) window.electron.ipcRenderer.send("set-bar", "none");
  };

  // 导出设置
  const exportSettings = async () => {
    console.log("[Frontend] Export settings clicked");
    try {
      // 收集渲染进程数据 (localStorage)
      const rendererData = {
        "setting-store": localStorage.getItem("setting-store"),
        "shortcut-store": localStorage.getItem("shortcut-store"),
      };

      const result = await window.api.store.export(rendererData);
      console.log("[Frontend] Export result:", result);
      if (result) {
        window.$message.success(t("message.export_settings_success"));
      } else {
        window.$message.error(t("message.export_settings_fail"));
      }
    } catch (error) {
      console.error("[Frontend] Export error:", error);
      window.$message.error(t("message.export_settings_error"));
    }
  };

  // 导入设置
  const importSettings = async () => {
    console.log("[Frontend] Import settings clicked");
    window.$dialog.warning({
      title: t("setting.other.import_settings"),
      content: t("message.import_settings_confirm"),
      positiveText: t("common.ok"),
      negativeText: t("common.cancel"),
      onPositiveClick: async () => {
        console.log("[Frontend] Import confirmed");
        try {
          const data = await window.api.store.import();
          console.log("[Frontend] Import data:", data);

          if (data) {
            // 恢复渲染进程数据
            if (data.renderer) {
              if (data.renderer["setting-store"])
                localStorage.setItem("setting-store", data.renderer["setting-store"]);
              if (data.renderer["shortcut-store"])
                localStorage.setItem("shortcut-store", data.renderer["shortcut-store"]);
            }

            window.$message.success(t("message.export_settings_success"));
            setTimeout(() => {
              window.location.reload();
            }, 1000);
          } else {
            window.$message.error(t("message.import_settings_fail"));
          }
        } catch (error) {
          console.error("[Frontend] Import error:", error);
          window.$message.error(t("message.import_settings_error"));
        }
      },
    });
  };

  // 重置设置
  const resetSetting = () => {
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
        show: isElectron,
        items: [
          {
            key: "closeAppMethod",
            label: t("setting.general.close_software"),
            type: "select",
            description: t("setting.general.close_software_tip"),
            disabled: computed(() => settingStore.showCloseAppTip),
            options: [
              {
                label: t("setting.general.close_software_value_hide"),
                value: "hide",
              },
              {
                label: t("setting.general.close_software_value_close"),
                value: "close",
              },
            ],
            value: computed({
              get: () => settingStore.closeAppMethod,
              set: (v) => (settingStore.closeAppMethod = v),
            }),
          },
          {
            key: "showCloseAppTip",
            label: t("setting.general.show_close_app_tip"),
            type: "switch",
            value: computed({
              get: () => settingStore.showCloseAppTip,
              set: (v) => (settingStore.showCloseAppTip = v),
            }),
          },
          {
            key: "showTaskbarProgress",
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
        show: isElectron,
        items: [
          {
            key: "exportSettings",
            label: t("setting.other.export_settings"),
            type: "button",
            description: t("setting.other.export_settings_tip"),
            buttonLabel: t("setting.other.export_settings"),
            action: exportSettings,
            componentProps: { type: "primary" },
          },
          {
            key: "importSettings",
            label: t("setting.other.import_settings"),
            type: "button",
            description: t("setting.other.import_settings_tip"),
            buttonLabel: t("setting.other.import_settings"),
            action: importSettings,
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
            componentProps: { type: "warning" },
          },
          {
            key: "clearAllData",
            label: t("setting.other.clear_all_data"),
            type: "button",
            description: t("setting.other.clear_all_data_tip"),
            buttonLabel: t("setting.other.clear_all_data_btn"),
            action: clearAllData,
            componentProps: { type: "error" },
          },
        ],
      },
    ],
  };
};
