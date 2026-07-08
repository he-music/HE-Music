<template>
  <Transition
    name="fadeDown"
    mode="out-in"
    @after-enter="calcSearchSuggestHeights"
    @after-leave="calcSearchSuggestHeights"
  >
    <n-card
      v-if="statusStore.searchFocus && statusStore.searchInputValue"
      class="search-suggest"
      content-style="padding: 0"
      :style="{
        height: `${searchSuggestHeights}px`,
        border: searchSuggestHeights === 0 ? 'none' : null,
      }"
    >
      <n-scrollbar class="scrollbar">
        <!-- 直接搜索 -->
        <div
          ref="directSearchRef"
          class="direct"
          @click="emit('toSearch', statusStore.searchInputValue, 'keyword')"
        >
          <SvgIcon name="Search" :depth="3" />
          <n-text class="text text-hidden">
            {{ `${t("search.direct_search")} ${statusStore.searchInputValue}` }}
          </n-text>
        </div>
        <!-- 搜索建议 -->
        <Transition name="fade" mode="out-in" @after-leave="calcSearchSuggestHeights">
          <div v-if="searchSuggestData?.length" ref="searchSuggestRef" class="all-suggest">
            <div v-for="(suggestItem, index) in searchSuggestData" :key="index" class="suggest">
              <div class="suggest-item" @click="emit('toSearch', suggestItem, 'keyword')">
                <!--                <n-text class="name">{{ suggestItem }}</n-text>-->
                <n-highlight
                  class="name"
                  :text="suggestItem"
                  :patterns="[statusStore.searchInputValue.trim()]"
                  highlight-class="highlight"
                />
              </div>
            </div>
          </div>
        </Transition>
      </n-scrollbar>
    </n-card>
  </Transition>
</template>

<script setup lang="ts">
import { searchSuggest } from "@/api/search";
import { usePlatformStore, useStatusStore } from "@/stores";
import { FeatureSupportFlag } from "@/api/platform";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const emit = defineEmits<{
  toSearch: [key: number | string, type: string];
}>();

const statusStore = useStatusStore();
const platformStore = usePlatformStore();

// 搜索建议数据
const searchSuggestData = ref<string[]>([]);
const searchSuggestHeights = ref<number>(0);

// 搜索建议元素
const directSearchRef = ref<HTMLElement | null>(null);
const searchSuggestRef = ref<HTMLElement | null>(null);

// 获取搜索建议
const getSearchSuggest = async (keywords: string) => {
  searchSuggestData.value = [];
  const platform = platformStore.platforms.find(
    (item) => item.feature_support_flag & FeatureSupportFlag.GetSearchSuggest && item.status === 1,
  );
  if (!platform) {
    return;
  }
  const result = await searchSuggest(keywords, platform?.id || "");
  searchSuggestData.value = result.keys;
  // 计算高度
  nextTick(calcSearchSuggestHeights);
};

// 计算高度
const calcSearchSuggestHeights = () => {
  const directSearchHeight = directSearchRef.value?.offsetHeight;
  const searchSuggestionsHeight = searchSuggestRef.value?.offsetHeight;
  if (directSearchHeight || searchSuggestionsHeight) {
    const totalHeight =
      (directSearchHeight || 0) +
      (searchSuggestionsHeight || 0) +
      (searchSuggestionsHeight ? 8 : 0) +
      20;
    searchSuggestHeights.value = totalHeight;
  } else {
    searchSuggestHeights.value = 0;
  }
};

// 搜索框改变
watchDebounced(
  () => statusStore.searchInputValue,
  (val) => {
    if (!val || val === "") return;
    getSearchSuggest(val);
  },
  { debounce: 300 },
);
</script>

<style lang="scss" scoped>
.search-suggest {
  position: absolute;
  left: 0;
  top: 50px;
  width: 300px;
  border-radius: 8px;
  overflow: hidden;
  max-height: calc(100vh - 160px);
  z-index: 101;
  transition:
    height 0.3s ease,
    opacity 0.3s ease,
    transform 0.3s ease;
  :deep(.scrollbar) {
    max-height: calc(100vh - 160px);
    .n-scrollbar-content {
      padding: 10px;
    }
  }
  @media (max-width: 768px) {
    width: 100%;
  }
  .direct {
    display: flex;
    align-items: center;
    padding: 6px;
    border-radius: 8px;
    transition: background-color 0.3s;
    cursor: pointer;
    .n-icon {
      font-size: 16px;
      margin-right: 6px;
    }
    &:hover {
      background-color: var(--n-border-color);
    }
  }
  .all-suggest {
    margin-top: 8px;
    .suggest {
      margin-bottom: 8px;
      .suggest-type {
        display: flex;
        align-items: center;
        margin-bottom: 8px;
        color: var(--n-color-target);
        .n-icon {
          font-size: 18px;
          margin-right: 4px;
        }
        .n-text {
          color: var(--n-color-target);
        }
      }
      .suggest-item {
        padding: 14px 18px 14px 22px;
        margin-bottom: 8px;
        border-radius: 8px;
        transition: background-color 0.3s;
        cursor: pointer;
        .name {
          white-space: normal;
        }
        .artist {
          &::before {
            content: " - ";
          }
        }
        &:last-child {
          margin-bottom: 0;
        }
        &:hover {
          background-color: var(--n-border-color);
        }
      }
      &:last-child {
        margin-bottom: 0;
      }
    }
  }
}
</style>
