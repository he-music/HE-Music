<template>
  <n-skeleton class="sheet-page-skeleton" aria-hidden="true" />
</template>

<style scoped lang="scss">
.sheet-page-skeleton {
  --page-height: max(254px, calc(var(--layout-height, 600) * 1px - 226px));
  flex-shrink: 0;
  width: min(100%, calc(var(--page-height) * 210 / 297));
  height: auto;
  aspect-ratio: 210 / 297;
  border-radius: 2px;
}
</style>
