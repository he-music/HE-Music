<template>
  <div class="recommend-online">
    <PageSectionList v-if="sections.length" :sections="sections" :platform="platform" />
    <PageSectionSkeleton v-else-if="initialLoading" />
    <n-result
      v-else-if="initialError"
      status="error"
      :title="t('page_section.load_failed')"
      :description="t('page_section.load_failed_description')"
    >
      <template #footer>
        <n-button secondary type="primary" @click="loadPage(1)">
          {{ t("page_section.retry") }}
        </n-button>
      </template>
    </n-result>
    <n-empty v-else :description="t('page_section.empty')" size="large" />

    <div v-if="sections.length" class="pagination-state">
      <div ref="loadMoreTrigger" class="load-more-trigger" aria-hidden="true" />
      <n-flex v-if="loadingMore" align="center" justify="center" class="status-line">
        <n-spin size="small" />
        <n-text depth="3">{{ t("page_section.loading_more") }}</n-text>
      </n-flex>
      <n-button
        v-else-if="loadMoreError"
        secondary
        type="primary"
        class="retry-button"
        @click="loadNextPage"
      >
        {{ t("page_section.retry") }}
      </n-button>
      <n-divider v-else-if="!hasMore" dashed>
        {{ t("common.no_more_data") }}
      </n-divider>
    </div>
  </div>
</template>

<script setup lang="ts">
import { recommendPage } from "@/api/page";
import PageSectionList from "@/components/Page/PageSectionList.vue";
import PageSectionSkeleton from "@/components/Page/PageSectionSkeleton.vue";
import type { NormalizedPageSection } from "@/types/page";
import { appendPageSections, normalizePageSections } from "@/utils/pageSection";
import { useIntersectionObserver } from "@vueuse/core";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  platform: string;
}>();

const { t } = useI18n();
const sections = ref<NormalizedPageSection[]>([]);
const pageIndex = ref(0);
const hasMore = ref(true);
const initialLoading = ref(true);
const loadingMore = ref(false);
const initialError = ref(false);
const loadMoreError = ref(false);
const requestPending = ref(false);
const loadMoreTrigger = ref<HTMLElement | null>(null);
const triggerVisible = ref(false);

const loadPage = async (targetPage: number) => {
  if (requestPending.value) return;

  const isInitial = targetPage === 1 && sections.value.length === 0;
  requestPending.value = true;
  initialError.value = false;
  loadMoreError.value = false;
  if (isInitial) initialLoading.value = true;
  else loadingMore.value = true;

  try {
    const response = await recommendPage(props.platform, targetPage);
    const incoming = normalizePageSections(response.sections || []);

    pageIndex.value = targetPage;
    if (!incoming.length) {
      hasMore.value = false;
      if (import.meta.env.DEV && response.has_more) {
        console.warn(`[RecommendPage] 第 ${targetPage} 页无有效区块，已停止自动加载`);
      }
      return;
    }

    sections.value = appendPageSections(sections.value, incoming);
    hasMore.value = Boolean(response.has_more);
  } catch (error) {
    if (isInitial) initialError.value = true;
    else loadMoreError.value = true;
    console.error("Error getting recommend page:", error);
  } finally {
    requestPending.value = false;
    initialLoading.value = false;
    loadingMore.value = false;
  }
};

const loadNextPage = () => {
  if (!hasMore.value || requestPending.value) return;
  loadPage(pageIndex.value + 1);
};

useIntersectionObserver(
  loadMoreTrigger,
  ([entry]) => {
    triggerVisible.value = entry?.isIntersecting || false;
  },
  { rootMargin: "320px 0px" },
);

watch(
  [triggerVisible, hasMore, initialLoading, loadingMore, loadMoreError],
  ([visible, canLoadMore, isInitialLoading, isLoadingMore, hasError]) => {
    if (visible && canLoadMore && !isInitialLoading && !isLoadingMore && !hasError) {
      loadNextPage();
    }
  },
);

onMounted(() => loadPage(1));
</script>

<style lang="scss" scoped>
.recommend-online {
  width: 100%;
  min-width: 0;
  padding-bottom: 24px;

  > .n-result,
  > .n-empty {
    margin-top: 72px;
  }
}

.pagination-state {
  display: flex;
  min-height: 76px;
  align-items: center;
  justify-content: center;
  padding: 10px 0 18px;
}

.load-more-trigger {
  width: 1px;
  height: 1px;
}

.status-line {
  min-height: 40px;
}

.retry-button {
  min-width: 88px;
}

.n-divider {
  margin: 14px 0;
}
</style>
