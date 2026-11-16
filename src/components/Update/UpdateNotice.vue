<template>
  <n-button
    v-if="state?.availableVersion"
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
import { platform } from "@/platform";
import { updatesState as state } from "@/platform/updates";

const { t } = useI18n();
const label = computed(() =>
  t(state.value?.installed ? "updates.restart" : "updates.available_short"),
);
async function openUpdate(): Promise<void> {
  try {
    await platform.updates?.check();
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
