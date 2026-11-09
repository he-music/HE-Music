import { applicationStorage, flushApplicationWrites } from "@/platform/applicationStorage";
import { computed, nextTick, onScopeDispose, ref, toValue, type MaybeRefOrGetter } from "vue";
import { useDataStore, useSettingStore } from "@/stores";
import type { PreferencesResetFilesOwner } from "@/platform/preferencesResetOwner";
import {
  executePreferencesReset,
  type PlatformPreferencesReset,
} from "@/platform/preferencesReset";
import { clearAdditionalPreferencesData } from "@/platform/preferencesResetData";
import type { PlatformLifecycle } from "@/platform/types";
import { t } from "@/i18n";

/** Owned by settings setup, alongside import/export; never create in a computed getter. */
export function usePreferencesResetActions(
  native: PlatformPreferencesReset | undefined,
  lifecycle: Pick<PlatformLifecycle, "restart"> | undefined,
  owner: MaybeRefOrGetter<PreferencesResetFilesOwner | undefined>,
) {
  const settingStore = useSettingStore();
  const dataStore = useDataStore();
  const pending = ref(false);
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
  });
  const disabled = computed(
    () => pending.value || !native || !lifecycle || !toValue(owner)?.current(),
  );
  const request = (mode: "settings" | "all") => {
    const capturedOwner = toValue(owner);
    if (disposed || disabled.value || !native || !lifecycle || !capturedOwner) return;
    pending.value = true;
    let confirmed = false;
    let cancelled = false;
    const release = () => {
      if (!confirmed) {
        cancelled = true;
        pending.value = false;
      }
    };
    window.$dialog.warning({
      title: t("common.warning"),
      content: t(mode === "settings" ? "mygo.reset_settings_confirm" : "mygo.reset_all_confirm"),
      positiveText: t("common.ok"),
      negativeText: t("common.cancel"),
      onNegativeClick: release,
      onClose: release,
      onAfterLeave: release,
      onPositiveClick: async () => {
        if (disposed || confirmed || cancelled) return;
        confirmed = true;
        const result = await executePreferencesReset({
          mode,
          native,
          current: () => !disposed && capturedOwner.current(),
          clearRenderer: async () => {
            // Drain renderer download persistence before deleting its history.
            // Native revoke already fenced unclaimed IO when committing intent.
            await capturedOwner.dispose();
            if (disposed || !capturedOwner.current()) throw new Error("Settings owner disposed");
            if (mode === "settings") {
              settingStore.$reset();
              await nextTick();
            } else {
              applicationStorage.clear();
              window.sessionStorage.clear();
              await dataStore.deleteDB();
              await clearAdditionalPreferencesData(() => !disposed && capturedOwner.current());
            }
            await flushApplicationWrites();
          },
          restart: () => lifecycle.restart(),
          reportRendererFailure: () => {
            if (!disposed) window.$message.error(t("mygo.reset_renderer_failed"));
          },
        });
        if (disposed) return;
        if (result.status === "native-failed") {
          pending.value = false;
          confirmed = false;
          window.$message.error(t("mygo.reset_native_failed"));
        } else if (result.status === "scheduled") {
          if (result.restartFailed) window.$message.error(t("mygo.reset_restart_failed"));
          else if (!result.rendererFailed) window.$message.success(t("mygo.reset_scheduled"));
        }
      },
    });
  };
  return { disabled, pending, request };
}
