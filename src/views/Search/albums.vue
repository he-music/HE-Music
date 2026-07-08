<template>
  <div class="search-type">
    <!--    <Transition name="fade" mode="out-in">-->
    <AlbumList
      v-if="searchCount > 0"
      :data="searchResultData"
      :loading="loading"
      :load-more="hasMore"
      @load-more="loadMore"
    />
    <n-empty
      v-else
      :description="t('search.no_album_result', { keyword })"
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
import type { AlbumInfo } from "@/types/main.hemusic";
import { searchResultHemusic } from "@/api/search";
import AlbumList from "@/components/List/AlbumList.vue";
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
const searchResultData = ref<AlbumInfo[]>([]);

// 获取搜索结果
const getSearchResult = async () => {
  // 获取数据
  loading.value = true;
  searchResultHemusic(props.keyword, 30, searchPage.value, props.platform, "album")
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
    searchPage.value++;
    getSearchResult();
  } else {
    loading.value = false;
  }
};
onMounted(() => {
  console.log("albums Mounted");
  getSearchResult();
});
</script>
