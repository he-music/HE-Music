import { computed, onScopeDispose, ref } from "vue";
import { useSettingStore, useShortcutStore } from "@/stores";
import { t } from "@/i18n";
import { filesSession } from "@/platform/filesSession";
import { serializeRendererSettings, writeRendererSettings } from "@/platform/rendererSettings";

/** Settings-page ownership is separate from the shared shell file session. */
export function useSettingsFiles() {
  const setting = useSettingStore();
  const shortcut = useShortcutStore();
  const pending = ref(false);
  const reloading = ref(false);
  let disposed = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const disabled = computed(
    () =>
      pending.value ||
      reloading.value ||
      !filesSession.value?.ready.value ||
      filesSession.value.busy.value,
  );
  onScopeDispose(() => {
    disposed = true;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
  });
  const current = (session: typeof filesSession.value) =>
    !disposed && session !== undefined && filesSession.value === session && session.ready.value;
  const failure = () => window.$message.error(t("message.settings_file_failed"));

  const exportSettings = async () => {
    if (disposed || disabled.value) return;
    const session = filesSession.value;
    if (!session) return;
    pending.value = true;
    try {
      // Read the current two Pinia states, without data/account/native stores or storage lag.
      const snapshot = serializeRendererSettings(setting.$state, shortcut.$state);
      const result = await session.exportSettings(snapshot);
      if (!current(session)) return;
      if (result.status === "completed") {
        if (result.value.status === "saved") {
          window.$message.success(t("message.export_settings_success"));
        }
      } else if (result.status === "busy") {
        window.$message.warning(t("message.settings_file_busy"));
      } else if (result.status !== "stale") failure();
    } catch {
      if (current(session)) failure();
    } finally {
      pending.value = false;
    }
  };

  const importSettings = () => {
    if (disposed || disabled.value) return;
    const session = filesSession.value;
    if (!session) return;
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
      content: t("message.import_renderer_settings_confirm"),
      positiveText: t("common.ok"),
      negativeText: t("common.cancel"),
      onNegativeClick: release,
      onClose: release,
      onAfterLeave: release,
      onPositiveClick: async () => {
        if (confirmed || cancelled) return;
        confirmed = true;
        try {
          if (!current(session)) return;
          const result = await session.importSettings();
          if (!current(session)) return;
          if (result.status === "completed") {
            if (result.value.status === "cancelled") return;
            const document = result.value.document;
            if (
              !document ||
              document.format !== "he-music-renderer-settings" ||
              document.version !== 1
            ) {
              failure();
              return;
            }
            const written = writeRendererSettings(localStorage, document.renderer);
            if (written === "rollback-failed") {
              window.$message.error(t("message.settings_restore_failed"));
              return;
            }
            if (written !== "saved") {
              failure();
              return;
            }
            reloading.value = true;
            window.$message.success(t("message.import_settings_success"));
            reloadTimer = setTimeout(() => {
              reloadTimer = undefined;
              if (current(session)) window.location.reload();
            }, 1000);
          } else if (result.status === "busy") {
            window.$message.warning(t("message.settings_file_busy"));
          } else if (result.status !== "stale") failure();
        } catch {
          if (current(session)) failure();
        } finally {
          pending.value = false;
        }
      },
    });
  };
  return { disabled, exportSettings, importSettings };
}
