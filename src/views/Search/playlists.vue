<template>
  <div class="search-type">
    <!--    <Transition name="fade" mode="out-in">-->
    <PlaylistList
      v-if="searchCount > 0"
      :data="searchResultData"
      :loading="loading"
      :load-more="hasMore"
      @load-more="loadMore"
    />
    <n-empty
      v-else
      :description="t('search.no_playlist_result', { keyword })"
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
import PlaylistList from "@/components/List/PlaylistList.vue";
import type { PlaylistInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const props = defineProps<{
  keyword: string;
  platform: string;
}>();

// 搜索数据
const hasMore = ref<boolean>(true);
const loading = ref<boolean>(true);
const searchPage = ref<number>(1);
const searchCount = ref<number>(1);
const searchResultData = ref<PlaylistInfo[]>([]);

// 获取搜索结果
const getSearchResult = async () => {
  // 获取数据
  loading.value = true;
  searchResultHemusic(props.keyword, 30, searchPage.value, props.platform, "playlist")
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
const loadMore = () => {
  if (hasMore.value) {
    console.log("加载");
    searchPage.value++;
    getSearchResult();
  } else {
    loading.value = false;
  }
};
onMounted(() => {
  console.log("playlist Mounted");
  getSearchResult();
});
</script>
