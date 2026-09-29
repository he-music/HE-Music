<template>
  <div class="async-content">
    <n-result
      v-if="failed && !hasData"
      status="error"
      size="small"
      :title="t('page_section.load_failed')"
      :description="t('page_section.load_failed_description')"
    >
      <template #footer>
        <n-button secondary type="primary" :loading="loading" @click="emit('retry')">
          {{ t("page_section.retry") }}
        </n-button>
      </template>
    </n-result>
    <slot v-else />
    <n-flex v-if="failed && hasData" class="retry" justify="center" align="center" role="status">
      <n-text depth="3">{{ t("page_section.load_failed") }}</n-text>
      <n-button secondary type="primary" :loading="loading" @click="emit('retry')">
        {{ t("page_section.retry") }}
      </n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";

defineProps<{ failed: boolean; loading: boolean; hasData?: boolean }>();
const emit = defineEmits<{ retry: [] }>();
const { t } = useI18n();
</script>

<style scoped>
.async-content {
  position: relative;
  min-width: 0;
}
.n-result {
  padding: 24px 0;
}
.retry {
  position: sticky;
  bottom: 0;
  z-index: 2;
  flex-shrink: 0;
  background: rgb(var(--background));
  padding: 16px 0;
}
</style>
