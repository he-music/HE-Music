import { computed, type Ref } from "vue";
import type { UpdatesState } from "@/platform/updates";

/** The SDK reports bytes, but does not distinguish verification from replacement. */
export function useUpdateProgress(state: Ref<UpdatesState | undefined>) {
  const finishing = computed(() => {
    const value = state.value;
    return value?.phase === "installing" && value.total > 0 && value.downloaded >= value.total;
  });
  const percent = computed(() => {
    const value = state.value;
    return value && value.total > 0
      ? Math.max(0, Math.min(100, Math.round((value.downloaded / value.total) * 1000) / 10))
      : null;
  });
  const downloadedMB = computed(() => ((state.value?.downloaded ?? 0) / 1024 / 1024).toFixed(1));
  const totalMB = computed(() => ((state.value?.total ?? 0) / 1024 / 1024).toFixed(1));
  return { finishing, percent, downloadedMB, totalMB };
}
