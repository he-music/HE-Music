<template>
  <div ref="rootRef" class="page-platform-tabs">
    <PageTabs :value="value" @update:value="emit('update:value', $event)">
      <slot />
    </PageTabs>
  </div>
</template>

<script setup lang="ts">
import PageTabs from "./PageTabs.vue";
const props = defineProps<{ value?: string }>();
const emit = defineEmits<{ "update:value": [value: string] }>();
const rootRef = ref<HTMLElement | null>(null);

watch(
  () => props.value,
  (value) => {
    if (!value) return;
    const scrollContainers = rootRef.value?.querySelectorAll<HTMLElement>(
      ".page-platform-scroll > .n-scrollbar-container",
    );
    scrollContainers?.forEach((container) => container.scrollTo({ top: 0 }));
  },
  { flush: "post" },
);
</script>

<style lang="scss" scoped>
.page-platform-tabs {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;

  :deep(> .page-tabs),
  :deep(> .page-tabs > .n-tab-pane),
  :deep(.page-secondary-tabs),
  :deep(.page-secondary-tabs > .n-tab-pane) {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  :deep(> .page-tabs > .n-tabs-nav),
  :deep(.page-secondary-tabs > .n-tabs-nav) {
    flex: none;
  }
}
</style>
