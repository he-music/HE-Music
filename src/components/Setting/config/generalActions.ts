import { applicationStorage } from "@/platform/applicationStorage";
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { isElectron } from "@/utils/env";
import { platform } from "@/platform";
import { t } from "@/i18n";
import type { PreferencesResetFilesOwner } from "@/platform/preferencesResetOwner";
import { filesSession } from "@/platform/filesSession";
import { usePreferencesResetActions } from "./preferencesResetActions";
import { useSettingsFiles } from "./settingsFiles";

/** Create once in the owning settings page setup, outside config computed getters. */
export function useGeneralSettingsActions() {
  const files = useSettingsFiles();
  // Bind this settings scope to its first ready FilesSession, including when
  // settings mount before shell startup finishes. Never rebind to a replacement.
  const resetOwner = shallowRef<PreferencesResetFilesOwner>();
  watch(
    filesSession,
    (session) => {
      if (!resetOwner.value) resetOwner.value = session?.capturePreferencesResetOwner();
    },
    { immediate: true, flush: "sync" },
  );
  const preferencesReset = usePreferencesResetActions(
    platform.preferencesReset,
    platform.lifecycle,
    resetOwner,
  );
  const pending = ref(false);
  const reloading = ref(false);
  let disposed = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  onScopeDispose(() => {
    disposed = true;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
  });
  const disabled = computed(() =>
    isElectron
      ? pending.value || reloading.value
      : files.disabled.value || (platform.kind === "mygo" && preferencesReset.pending.value),
  );
  const resetDisabled = computed(() => disabled.value || preferencesReset.disabled.value);
  const exportSettings = async () => {
    if (disposed || disabled.value) return;
    if (platform.kind === "mygo") return files.exportSettings();
    if (!isElectron) return;
    pending.value = true;
    try {
      const rendererData = {
        "setting-store": applicationStorage.getItem("setting-store"),
        "shortcut-store": applicationStorage.getItem("shortcut-store"),
      };
      const result = await window.api.store.export(rendererData);
      if (disposed) return;
      if (result) window.$message.success(t("message.export_settings_success"));
      else window.$message.error(t("message.export_settings_fail"));
    } catch {
      if (disposed) return;
      console.error("设置导出失败");
      window.$message.error(t("message.export_settings_error"));
    } finally {
      pending.value = false;
    }
  };
  const importSettings = () => {
    if (disposed || disabled.value) return;
    if (platform.kind === "mygo") return files.importSettings();
    if (!isElectron) return;
    pending.value = true;
    let confirmed = false;
    let cancelled = false;
    const release = () => {
      if (!confirmed && !cancelled) {
        cancelled = true;
        pending.value = false;
      }
    };
    window.$dialog.warning({
      title: t("setting.other.import_settings"),
      content: t("message.import_settings_confirm"),
      positiveText: t("common.ok"),
      negativeText: t("common.cancel"),
      onNegativeClick: release,
      onClose: release,
      onAfterLeave: release,
      onPositiveClick: async () => {
        if (disposed || confirmed || cancelled) return;
        confirmed = true;
        try {
          const data = await window.api.store.import();
          if (disposed) return;
          if (data) {
            if (data.renderer) {
              if (data.renderer["setting-store"])
                applicationStorage.setItem("setting-store", data.renderer["setting-store"]);
              if (data.renderer["shortcut-store"])
                applicationStorage.setItem("shortcut-store", data.renderer["shortcut-store"]);
            }
            reloading.value = true;
            window.$message.success(t("message.import_settings_success"));
            reloadTimer = setTimeout(() => {
              reloadTimer = undefined;
              if (!disposed) window.location.reload();
            }, 1000);
          } else window.$message.error(t("message.import_settings_fail"));
        } catch {
          if (disposed) return;
          console.error("设置导入失败");
          window.$message.error(t("message.import_settings_error"));
        } finally {
          pending.value = false;
        }
      },
    });
  };
  return { disabled, resetDisabled, exportSettings, importSettings, preferencesReset };
}

export type GeneralSettingsActions = ReturnType<typeof useGeneralSettingsActions>;
