<template>
  <n-space>
    <n-button :disabled="pending" @click="exportData">{{ t("mygo.export_data") }}</n-button>
    <n-button v-if="isMygo" :disabled="pending || !filesSession?.ready.value" @click="selectFile">
      {{ t("mygo.import_data") }}
    </n-button>
  </n-space>
  <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="readFile" />
</template>

<script setup lang="ts">
import { nextTick, onScopeDispose, ref } from "vue";
import { saveAs } from "file-saver";
import { t } from "@/i18n";
import { platform } from "@/platform";
import { filesSession } from "@/platform/filesSession";
import { flushApplicationWrites } from "@/platform/applicationStorage";
import {
  applicationBackupMaxBytes,
  exportApplicationBackup,
  parseApplicationBackup,
} from "@/platform/applicationBackup";

const isMygo = platform.kind === "mygo";
const pending = ref(false);
const fileInput = ref<HTMLInputElement>();
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});

const exportData = async () => {
  if (disposed || pending.value) return;
  pending.value = true;
  try {
    await nextTick();
    const data = await exportApplicationBackup(isMygo);
    if (disposed) return;
    saveAs(
      new Blob([JSON.stringify(data)], { type: "application/json" }),
      `HE-Music_Data_${Date.now()}.json`,
    );
  } catch {
    if (!disposed) window.$message.error(t("mygo.data_transfer_failed"));
  } finally {
    pending.value = false;
  }
};

const selectFile = () => {
  if (disposed || pending.value || !fileInput.value) return;
  fileInput.value.value = "";
  fileInput.value.click();
};

const readFile = async () => {
  const file = fileInput.value?.files?.[0];
  const session = filesSession.value;
  if (disposed || pending.value || !file || !session?.ready.value) return;
  pending.value = true;
  try {
    if (file.size > applicationBackupMaxBytes) throw new Error("Backup too large");
    const data = parseApplicationBackup(await file.text());
    if (disposed || filesSession.value !== session || !session.ready.value) {
      pending.value = false;
      return;
    }
    let confirmed = false;
    let cancelled = false;
    const release = () => {
      if (!confirmed) {
        cancelled = true;
        pending.value = false;
      }
    };
    window.$dialog.warning({
      title: t("mygo.import_data"),
      content: t("mygo.import_data_confirm"),
      positiveText: t("common.ok"),
      negativeText: t("common.cancel"),
      onNegativeClick: release,
      onClose: release,
      onAfterLeave: release,
      onPositiveClick: async () => {
        if (
          disposed ||
          confirmed ||
          cancelled ||
          filesSession.value !== session ||
          !session.ready.value
        )
          return;
        confirmed = true;
        const owner = session.capturePreferencesResetOwner();
        if (!owner) {
          pending.value = false;
          return;
        }
        let stopped = false;
        try {
          await owner.dispose();
          stopped = true;
          await flushApplicationWrites();
          if (!owner.current()) return;
          const { DesktopStorage } = await import("@/platform/mygo.bindings");
          await DesktopStorage.restore(data);
          // The native tree is now authoritative and old-document writes are
          // fenced. Reload even if settings closed while the RPC was in flight.
          window.location.reload();
        } catch {
          if (!disposed) {
            window.$message.error(t("mygo.data_transfer_failed"));
            if (stopped)
              window.$dialog.error({
                title: t("common.error"),
                content: t("mygo.data_reload_required"),
                positiveText: t("mygo.data_retry"),
                onPositiveClick: () => window.location.reload(),
              });
          } else if (stopped) window.location.reload();
        } finally {
          pending.value = false;
        }
      },
    });
  } catch {
    if (!disposed) window.$message.error(t("mygo.data_transfer_failed"));
    pending.value = false;
  }
};
</script>
