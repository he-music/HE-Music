<template>
  <div class="search-type" style="height: auto">
    <!--    <Transition name="fade" mode="out-in">-->
    <AlbumList :data="resultData" :loading="loading" :load-more="hasMore" @load-more="loadMore" />
  </div>
</template>

<script setup lang="ts">
import { newAlbums } from "@/api/album";
import type { AlbumInfo } from "@/types/main.hemusic";
import AlbumList from "@/components/List/AlbumList.vue";

const props = defineProps<{
  tab_id: string;
  platform: string;
}>();

// 搜索数据
const hasMore = ref<boolean>(true);
const loading = ref<boolean>(true);
const pageIndex = ref<number>(1);
const resultData = ref<AlbumInfo[]>([]);

// 获取搜索结果
const getNewAlbums = async () => {
  // 获取数据
  loading.value = true;
  const result = await newAlbums(props.platform, props.tab_id, pageIndex.value);
  // 是否还有
  hasMore.value = result?.has_more;
  // 处理数据
  resultData.value = resultData.value?.concat(result?.list);
  loading.value = false;
};

// 列表触底
const loadMore = () => {
  if (hasMore.value) {
    pageIndex.value++;
    getNewAlbums();
  } else {
    loading.value = false;
  }
};
onMounted(() => {
  getNewAlbums();
});
</script>
