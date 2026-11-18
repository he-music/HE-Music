<template>
  <span class="song-quality-label">
    <span class="quality-name">{{ description || name }}</span>
    <span v-if="(description && description !== name) || $slots.default" class="quality-details">
      <span v-if="description && description !== name" class="quality-code" translate="no">
        {{ name }}
      </span>
      <slot />
    </span>
  </span>
</template>

<script setup lang="ts">
defineProps<{
  name: string;
  description?: string;
}>();
</script>

<style scoped lang="scss">
.song-quality-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  height: 100%;
  min-width: 0;
  line-height: 1.5;

  .quality-name {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .quality-details {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 4px 12px;
    max-width: 55%;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    opacity: 0.65;
  }

  .quality-code {
    overflow-wrap: anywhere;
  }
}
</style>
