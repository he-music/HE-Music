<template>
  <n-button
    v-if="visible"
    class="update-notice"
    size="small"
    type="primary"
    secondary
    :title="t('updates.view')"
    :aria-label="`${label} · ${t('updates.view')}`"
    @click="openUpdate"
  >
    <template #icon><SvgIcon name="Update" :size="18" /></template>
    <span class="update-label">{{ label }}</span>
  </n-button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingStore } from "@/stores";
import { updatesSession } from "@/platform/updatesSession";
import { useUpdateProgress } from "@/composables/useUpdateProgress";
import { openMygoUpdate } from "@/utils/mygoUpdateModal";

const { t } = useI18n();
const setting = useSettingStore();
const session = updatesSession;
const state = computed(() => (session.value?.ready.value ? session.value.state.value : undefined));
const { finishing, percent } = useUpdateProgress(state);
const visible = computed(() => {
  const value = state.value;
  if (!value) return false;
  if (value.phase === "available") {
    return !!value.version && value.version !== setting.skippedUpdateVersion;
  }
  return (
    value.phase === "installing" ||
    value.phase === "installed" ||
    (value.phase === "error" && value.code === "install-failed")
  );
});
const label = computed(() => {
  if (state.value?.phase === "installed") return t("updates.restart");
  if (state.value?.phase === "error") return t("updates.failed");
  if (state.value?.phase === "installing") {
    if (finishing.value) return t("updates.finishing");
    return percent.value === null
      ? t("updates.downloading_unknown")
      : t("updates.downloading", { percent: percent.value });
  }
  return t("updates.available_short");
});
async function openUpdate(): Promise<void> {
  const owner = session.value;
  if (!owner?.ready.value) return;
  try {
    await openMygoUpdate(owner);
  } catch {
    window.$message?.error(t("updates.open_failed"));
  }
}
</script>

<style scoped lang="scss">
.update-notice {
  flex-shrink: 0;
  border-radius: 16px;
  -webkit-app-region: no-drag;
  --app-region: no-drag;
  .update-label {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 768px) {
    .update-label {
      display: none;
    }
  }
}
</style>
