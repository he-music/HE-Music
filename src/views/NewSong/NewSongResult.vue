<template>
  <div class="search-type" style="height: auto">
    <!--    <Transition name="fade" mode="out-in">-->
    <SongList
      :data="resultData"
      :loading="loading"
      load-more
      disabled-sort
      :height="songListHeight"
      @reach-bottom="reachBottom"
    />
  </div>
</template>

<script setup lang="ts">
import { newSongs } from "@/api/song";
import SongList from "@/components/List/SongList.vue";
import { useStatusStore } from "@/stores";
import type { SongInfo } from "@/types/main.hemusic";

const props = defineProps<{
  tab_id: string;
  platform: string;
}>();

const statusStore = useStatusStore();

// 搜索数据
const hasMore = ref<boolean>(true);
const loading = ref<boolean>(true);
const pageIndex = ref<number>(1);
const resultData = ref<SongInfo[]>([]);

// 获取搜索结果
const getNewSongs = async () => {
  // 获取数据
  loading.value = true;
  const result = await newSongs(props.platform, props.tab_id, pageIndex.value);
  // 是否还有
  hasMore.value = result?.has_more;
  // 处理数据
  resultData.value = resultData.value?.concat(result?.list);
  loading.value = false;
};

// 列表触底
const reachBottom = () => {
  if (hasMore.value) {
    pageIndex.value++;
    getNewSongs();
  } else {
    loading.value = false;
  }
};
onMounted(() => {
  getNewSongs();
});

// 列表高度
const songListHeight = computed(() => {
  return statusStore.mainContentHeight - 50;
});
</script>
