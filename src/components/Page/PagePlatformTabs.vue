<template>
  <div
    ref="rootRef"
    class="page-platform-tabs"
    :style="{ '--platform-tabs-height': `${platformTabsHeight}px` }"
  >
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
const navRef = computed(
  () => rootRef.value?.querySelector<HTMLElement>(":scope > .n-tabs > .n-tabs-nav") ?? null,
);
const { height: platformTabsHeight } = useElementSize(
  navRef,
  { width: 0, height: 0 },
  { box: "border-box" },
);

watch(
  () => props.value,
  (value) => {
    if (!value) return;
    rootRef.value?.closest<HTMLElement>(".n-scrollbar-container")?.scrollTo({ top: 0 });
  },
  { flush: "post" },
);
</script>

<style lang="scss" scoped>
.page-platform-tabs {
  width: 100%;

  :deep(> .n-tabs > .n-tabs-nav),
  :deep(.page-filters),
  :deep(.page-secondary-tabs > .n-tabs-nav) {
    position: sticky;
    background: var(
      --page-toolbar-background,
      var(--sticky-surface-background, rgb(var(--background)))
    );
    backdrop-filter: var(--sticky-surface-filter, none);
  }

  :deep(> .n-tabs > .n-tabs-nav) {
    top: 0;
    z-index: 20;
  }

  :deep(.page-filters) {
    padding-inline: 16px;
  }

  :deep(.page-filters),
  :deep(.page-secondary-tabs > .n-tabs-nav) {
    top: var(--platform-tabs-height);
    z-index: 19;
  }
}
</style>
