<template>
  <div class="manual-lyric-storage">
    <span role="status">{{ usageLabel }}</span>
    <n-button v-if="failed" size="small" secondary @click="refresh">
      {{ t("lyricSearch.retry") }}
    </n-button>
    <n-button
      size="small"
      secondary
      type="error"
      :disabled="!canClear"
      :loading="clearing"
      @click="confirmClear"
    >
      {{ t("lyricSearch.deleteAll") }}
    </n-button>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import type { DialogReactive } from "naive-ui";
import { useI18n } from "vue-i18n";
import { manualLyricRevision, manualLyrics } from "@/utils/manualLyrics";
import { useMusicStore } from "@/stores/music";
import { useStatusStore } from "@/stores/status";
import { manualLyricKey } from "@/utils/manualLyricRecord";
import lyricManager from "@/utils/lyricManager";
import { usePlayer } from "@/utils/player";
import { formatFileSize } from "@/utils/helper";

const { t } = useI18n();
const music = useMusicStore();
const status = useStatusStore();
const player = usePlayer();
const usage = ref<{ count: number; bytes: number }>();
const failed = ref(false);
const clearing = ref(false);
const canClear = computed(() => failed.value || !!usage.value?.count);
let generation = 0;
let dialog: DialogReactive | undefined;

const usageLabel = computed(() => {
  if (failed.value) return t("lyricSearch.usageFailed");
  if (!usage.value) return t("lyricSearch.usageLoading");
  return t("lyricSearch.usage", {
    count: usage.value.count,
    size: formatFileSize(usage.value.bytes),
  });
});

async function refresh() {
  const request = ++generation;
  failed.value = false;
  try {
    const result = await manualLyrics.usage();
    if (generation === request) usage.value = result;
  } catch {
    if (generation === request) failed.value = true;
  }
}

function confirmClear() {
  if (!canClear.value || dialog || clearing.value) return;
  dialog = window.$dialog.warning({
    title: t("lyricSearch.deleteAllTitle"),
    content: t("lyricSearch.deleteAllConfirm"),
    positiveText: t("lyricSearch.deleteAll"),
    negativeText: t("common.cancel"),
    onAfterLeave: () => (dialog = undefined),
    onPositiveClick: async () => {
      if (clearing.value) return false;
      clearing.value = true;
      try {
        await lyricManager.clearManualLyrics();
        const target = manualLyricKey(music.playSong);
        if (target && target === status.manualLyricTarget) await player.reloadTrackLyrics();
        window.$message.success(t("lyricSearch.deletedAll"));
        return true;
      } catch {
        window.$message.error(t("lyricSearch.deleteFailed"));
        return false;
      } finally {
        clearing.value = false;
      }
    },
  });
}

watch(manualLyricRevision, refresh, { immediate: true });
onScopeDispose(() => {
  generation++;
  dialog?.destroy();
});
</script>

<style scoped>
.manual-lyric-storage {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
</style>
