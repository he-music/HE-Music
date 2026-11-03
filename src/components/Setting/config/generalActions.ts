import { computed, shallowRef, watch } from "vue";
import { platform } from "@/platform";
import type { PreferencesResetFilesOwner } from "@/platform/preferencesResetOwner";
import { filesSession } from "@/platform/filesSession";
import { usePreferencesResetActions } from "./preferencesResetActions";
import { useSettingsFiles } from "./settingsFiles";

/** Create once in the owning settings page setup, outside config computed getters. */
export function useGeneralSettingsActions() {
  const files = useSettingsFiles();
  // Capture the first ready owner; a replacement session cannot reuse its authority.
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
  const disabled = computed(
    () => files.disabled.value || (platform.kind === "mygo" && preferencesReset.pending.value),
  );
  const resetDisabled = computed(() => disabled.value || preferencesReset.disabled.value);
  return {
    disabled,
    resetDisabled,
    exportSettings: () => {
      return disabled.value ? undefined : files.exportSettings();
    },
    importSettings: () => {
      return disabled.value ? undefined : files.importSettings();
    },
    preferencesReset,
  };
}

export type GeneralSettingsActions = ReturnType<typeof useGeneralSettingsActions>;
