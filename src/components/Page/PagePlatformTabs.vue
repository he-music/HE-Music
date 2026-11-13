<template>
  <div
    ref="rootRef"
    class="page-platform-tabs"
    :style="{ '--platform-tabs-height': `${platformTabsHeight}px` }"
  >
    <n-tabs :value="value" type="bar" @update:value="updateValue">
      <slot />
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
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

const updateValue = (value: string | number) => emit("update:value", String(value));

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

  :deep(> .n-tabs > .n-tabs-nav) {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--sticky-surface-background, rgb(var(--background)));
    backdrop-filter: var(--sticky-surface-filter, none);
  }

  :deep(.page-filters),
  :deep(.page-secondary-tabs > .n-tabs-nav) {
    position: sticky;
    top: var(--platform-tabs-height);
    z-index: 19;
    background: var(--sticky-surface-background, rgb(var(--background)));
    backdrop-filter: var(--sticky-surface-filter, none);
  }
}
</style>
