<template>
  <section
    class="sheet-reader"
    :aria-label="t('sheet_music.title')"
    tabindex="0"
    @keydown="handleKeydown"
  >
    <div class="reader-toolbar">
      <div class="pagination">
        <n-button size="small" secondary round :disabled="!canPrevious" @click="previousPage">{{
          t("sheet_music.previous_page")
        }}</n-button>
        <n-text class="page-number" aria-live="polite">
          {{ t("sheet_music.page_position", { page: current + 1, count: pages.length }) }}
        </n-text>
        <n-button size="small" secondary round :disabled="!canNext" @click="nextPage">
          {{ t("sheet_music.next_page") }}
        </n-button>
      </div>
    </div>
    <div class="paper-area">
      <n-image
        :key="currentUrl"
        class="score-page"
        :src="currentUrl"
        :alt="t('sheet_music.page', { page: current + 1 })"
        :img-props="imageProps"
        preview-disabled
        @load="imageLoaded = true"
        @error="imageFailed = true"
        @click="openPreview"
      >
        <template #placeholder>
          <div
            class="image-skeleton"
            role="status"
            :aria-label="t('common.loading')"
            aria-busy="true"
          >
            <SheetMusicPageSkeleton />
          </div>
        </template>
        <template #error>
          <div class="image-state">
            <n-text depth="3">{{ t("sheet_music.image_failed") }}</n-text>
            <n-button size="small" secondary round @click.stop="emit('retry')">
              {{ t("page_section.retry") }}
            </n-button>
          </div>
        </template>
      </n-image>
    </div>
    <n-image-group
      v-model:show="previewShown"
      v-model:current="current"
      :src-list="pages"
      show-toolbar-tooltip
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NImage, NImageGroup } from "naive-ui";
import SheetMusicPageSkeleton from "./SheetMusicPageSkeleton.vue";

const props = defineProps<{ pages: string[] }>();
const emit = defineEmits<{ retry: [] }>();
const { t } = useI18n();
const current = ref(0);
const previewShown = ref(false);
const imageLoaded = ref(false);
const imageFailed = ref(false);
const currentUrl = computed(() => props.pages[current.value] ?? "");
const canPrevious = computed(() => current.value > 0);
const canNext = computed(() => current.value < props.pages.length - 1);
const imageProps = {
  tabindex: 0,
  role: "button",
  onKeydown: (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPreview();
    }
  },
  style: {
    maxWidth: "100%",
    maxHeight: "max(254px, calc(var(--layout-height, 600) * 1px - 226px))",
    width: "auto",
    height: "auto",
  },
};

const previousPage = () => {
  if (canPrevious.value) current.value--;
};
const nextPage = () => {
  if (canNext.value) current.value++;
};
const handleKeydown = (event: KeyboardEvent) => {
  // 放大预览由 Naive UI 处理方向键，避免同一次按键触发两次翻页。
  if (previewShown.value || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    previousPage();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    nextPage();
  }
};
const openPreview = () => {
  if (imageLoaded.value && !imageFailed.value) previewShown.value = true;
};
watch(
  () => props.pages,
  () => {
    current.value = 0;
    previewShown.value = false;
  },
  { flush: "sync" },
);
watch(
  currentUrl,
  () => {
    imageLoaded.value = false;
    imageFailed.value = false;
  },
  { flush: "sync" },
);
</script>

<style scoped lang="scss">
.sheet-reader {
  max-width: 1000px;
  margin: 0 auto;
  min-width: 0;
  border: 1px solid rgba(var(--primary), 0.08);
  border-radius: 10px;
  overflow: hidden;
  &:focus-visible {
    outline: 2px solid rgba(var(--primary), 0.5);
    outline-offset: 4px;
  }
  .reader-toolbar {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid rgba(var(--primary), 0.08);
  }
  .pagination {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .page-number {
    min-width: 70px;
    text-align: center;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .paper-area {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 280px;
    box-sizing: border-box;
    padding: 12px;
    background: rgba(var(--primary), 0.025);
  }
  .score-page {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    height: auto;
    :deep(img) {
      cursor: zoom-in;
    }
  }
  .image-skeleton {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
  }
  .image-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    width: 100%;
    min-height: 180px;
  }
}
</style>
