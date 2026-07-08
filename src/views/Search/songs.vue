<template>
  <div class="search-type" style="height: auto">
    <!--    <Transition name="fade" mode="out-in">-->
    <SongList
      v-if="searchCount > 0"
      :data="searchResultData"
      :loading="loading"
      doubleClickAction="add"
      load-more
      disabled-sort
      :height="songListHeight"
      @reach-bottom="reachBottom"
      :show-header="!isSmall"
    />
    <n-empty
      v-else
      :description="t('search.no_song_result', { keyword })"
      style="margin-top: 60px"
      size="large"
    >
      <template #icon>
        <SvgIcon name="SearchOff" />
      </template>
    </n-empty>
    <!--    </Transition>-->
  </div>
</template>

<script setup lang="ts">
import { searchResultHemusic } from "@/api/search";
import SongList from "@/components/List/SongList.vue";
import { useStatusStore } from "@/stores";
import type { SongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
import { useMobile } from "@/composables/useMobile";
const { t } = useI18n();
const { isSmall } = useMobile();

const props = defineProps<{
  keyword: string;
  platform: string;
}>();

const statusStore = useStatusStore();

// 搜索数据
const hasMore = ref<boolean>(true);
const loading = ref<boolean>(true);
const searchPage = ref<number>(1);
const searchCount = ref<number>(1);
const searchResultData = ref<SongInfo[]>([]);

// 获取搜索结果
const getSearchResult = async () => {
  // 获取数据
  loading.value = true;
  searchResultHemusic(props.keyword, 30, searchPage.value, props.platform)
    .then((result) => {
      // 是否还有
      hasMore.value = result?.has_more;
      // 搜索总数
      searchCount.value = result?.total_count;
      // 处理数据
      searchResultData.value = searchResultData.value?.concat(result?.list);
    })
    .finally(() => {
      loading.value = false;
    });
};

// 列表触底
const reachBottom = () => {
  if (hasMore.value) {
    searchPage.value++;
    getSearchResult();
  } else {
    loading.value = false;
  }
};

onMounted(() => {
  getSearchResult();
});

// 列表高度
const songListHeight = computed(() => {
  return statusStore.mainContentHeight - 175;
});
</script>
