<template>
  <n-tabs
    :value="value"
    :theme-overrides="tabTheme"
    class="page-tabs"
    :class="{ 'page-tabs--category': category }"
    type="bar"
    :size="category ? 'small' : 'medium'"
    :bar-width="24"
    @update:value="emit('update:value', String($event))"
  >
    <slot />
  </n-tabs>
</template>

<script setup lang="ts">
defineProps<{ category?: boolean; value?: string }>();
const emit = defineEmits<{ "update:value": [value: string] }>();

const tabTheme = {
  tabGapSmallBar: "4px",
  tabGapMediumBar: "4px",
  tabPaddingSmallBar: "0 12px",
  tabPaddingMediumBar: "0 12px",
};
</script>

<style lang="scss" scoped>
.page-tabs {
  :deep(> .n-tabs-nav) {
    padding: 4px 16px;
  }

  :deep(.n-tabs-tab) {
    min-height: 32px;
  }
}

.page-tabs--category {
  :deep(.n-tabs-bar) {
    visibility: hidden;
  }

  :deep(.n-tabs-tab) {
    border-radius: 999px;
  }

  @media (hover: hover) {
    :deep(.n-tabs-tab:not(.n-tabs-tab--disabled, .n-tabs-tab--active):hover) {
      background: rgba(var(--primary), 0.08);
    }
  }

  :deep(.n-tabs-tab.n-tabs-tab--active) {
    background: rgba(var(--primary), 0.16);
  }

  @media (prefers-contrast: more) {
    :deep(.n-tabs-tab--active) {
      box-shadow: inset 0 0 0 1px currentColor;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :deep(.n-tabs-tab) {
      transition: none;
    }
  }
}
</style>
