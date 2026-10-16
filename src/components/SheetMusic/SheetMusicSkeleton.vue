<template>
  <div
    class="sheet-skeleton"
    :class="layout"
    role="status"
    :aria-label="t('common.loading')"
    aria-busy="true"
  >
    <div v-if="layout === 'list'" class="list-skeleton" aria-hidden="true">
      <div v-for="item in 3" :key="item" class="list-item">
        <n-skeleton class="cover" width="80px" height="108px" />
        <div class="list-info">
          <n-skeleton text width="60%" height="24px" />
          <n-skeleton text width="38%" height="16px" />
          <div class="tags">
            <n-skeleton v-for="tag in 3" :key="tag" width="48px" height="22px" />
          </div>
          <n-skeleton text width="46%" height="16px" />
        </div>
      </div>
    </div>
    <div v-else class="detail-skeleton" aria-hidden="true">
      <div class="metadata">
        <n-skeleton width="48px" height="22px" />
        <n-skeleton width="60px" height="22px" />
        <n-skeleton text width="140px" height="18px" />
        <n-skeleton text width="80px" height="18px" />
      </div>
      <div class="reader-skeleton">
        <div class="toolbar">
          <n-skeleton v-for="item in 3" :key="item" width="70px" height="28px" round />
        </div>
        <div class="paper-area"><SheetMusicPageSkeleton /></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import SheetMusicPageSkeleton from "./SheetMusicPageSkeleton.vue";

defineProps<{ layout: "list" | "detail" }>();
const { t } = useI18n();
</script>

<style scoped lang="scss">
.sheet-skeleton {
  min-width: 0;
  &.detail {
    max-width: 1000px;
    margin: 0 auto;
  }
  .list-skeleton {
    display: grid;
    gap: 12px;
  }
  .list-item {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 16px;
    border: 1px solid rgba(var(--primary), 0.08);
    border-radius: 8px;
  }
  .cover {
    flex-shrink: 0;
    border-radius: 6px;
  }
  .list-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .tags,
  .metadata {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .tags {
    margin-top: 4px;
  }
  .metadata {
    margin-bottom: 16px;
  }
  .reader-skeleton {
    border: 1px solid rgba(var(--primary), 0.08);
    border-radius: 10px;
    overflow: hidden;
  }
  .toolbar {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 4px;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(var(--primary), 0.08);
  }
  .paper-area {
    display: flex;
    justify-content: center;
    align-items: center;
    box-sizing: border-box;
    min-height: 280px;
    padding: 12px;
    background: rgba(var(--primary), 0.025);
  }
}
</style>
