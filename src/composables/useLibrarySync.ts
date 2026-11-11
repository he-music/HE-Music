import { onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from "vue";
import { filesSession } from "@/platform/filesSession";
import { localFilesSession } from "@/platform/localFilesSession";
import { localAudioBlocked } from "@/platform/localAudioSession";
import { LibrarySync } from "@/platform/librarySync";

export function useLibrarySync(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const sync = new LibrarySync({
    windowEvents: window,
    documentEvents: document,
    visible: () => document.visibilityState !== "hidden",
    canRefresh: () => {
      const owner = filesSession.value;
      return Boolean(
        owner?.ready.value &&
        !owner.busy.value &&
        owner.directories.value.length &&
        !localFilesSession.value?.scanning.value &&
        !localAudioBlocked() &&
        !owner.downloads?.tasks.value.some((task) => !task.done),
      );
    },
    refresh: async (signal) => {
      await localFilesSession.value?.refreshWhenIdle(signal);
    },
    report: (error) => console.warn("本地曲库自动同步失败", error),
  });
  onMounted(() => sync.start());
  onActivated(() => sync.start());
  onDeactivated(() => sync.stop());
  onBeforeUnmount(() => sync.stop());
  watch(
    () => filesSession.value?.directories.value,
    () => void sync.request(true),
  );
}
