<template>
  <SheetMusicSkeleton v-if="loading" :layout="layout" />
  <n-result
    v-else-if="failed || notImplemented || unsupported"
    :status="failed ? 'error' : 'info'"
    :title="title"
    class="sheet-state"
  >
    <template #footer>
      <n-button secondary round @click="emit('retry')">{{ t("page_section.retry") }}</n-button>
    </template>
  </n-result>
  <slot v-else />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import SheetMusicSkeleton from "./SheetMusicSkeleton.vue";

const props = withDefaults(
  defineProps<{
    loading: boolean;
    failed: boolean;
    notImplemented: boolean;
    unsupported?: string;
    layout?: "list" | "detail";
  }>(),
  { layout: "list" },
);
const emit = defineEmits<{ retry: [] }>();
const { t } = useI18n();
const title = computed(() => {
  if (props.failed) return t("sheet_music.load_failed");
  if (props.notImplemented) return t("sheet_music.not_open");
  return props.unsupported;
});
</script>

<style scoped lang="scss">
.sheet-state {
  min-height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px 0;
}
</style>
