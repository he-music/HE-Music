<template>
  <div class="new-song-skeleton" aria-hidden="true">
    <div v-if="!isSmallScreen" class="list-heading">
      <n-skeleton width="14px" height="12px" round />
      <n-skeleton width="36px" height="12px" round />
      <n-skeleton width="36px" height="12px" round />
    </div>
    <div v-for="row in 10" :key="row" class="song-placeholder">
      <n-skeleton width="50px" height="50px" :sharp="false" />
      <div class="song-text">
        <n-skeleton :width="row % 2 ? '40%' : '60%'" height="14px" round />
        <n-skeleton width="28%" height="12px" round />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMobile } from "@/composables/useMobile";

const { isSmallScreen } = useMobile();
</script>

<style scoped>
.new-song-skeleton {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.list-heading {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 40px 1fr 1fr;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 12px;
}

.song-placeholder {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 76px;
  margin-bottom: 12px;
  padding: 0 16px 0 64px;
}

.song-text {
  flex: 1;
  display: grid;
  gap: 8px;
  max-width: 240px;
}

@media (max-width: 767.98px) {
  .song-placeholder {
    padding-inline-start: 12px;
  }
}
</style>
