<template>
  <div class="page-tab-skeleton" aria-hidden="true">
    <div v-for="(width, index) in widths" :key="index" class="tab-placeholder">
      <n-skeleton :width="width" height="14px" round />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ widths?: readonly number[] }>(), {
  widths: () => [28, 28, 28, 28, 28, 28],
});
</script>

<style scoped>
.page-tab-skeleton {
  display: flex;
  flex: none;
  gap: 4px;
  padding: 4px 16px;
  overflow: hidden;
}

.tab-placeholder {
  display: flex;
  flex: none;
  min-height: 32px;
  align-items: center;
  padding: 0 12px;
}
</style>
