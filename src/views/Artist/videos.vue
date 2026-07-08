<template>
  <div class="artist-type">
    <VideoList
      :data="videoData"
      :loading="loading"
      :load-more="hasMore"
      type="video"
      cols="2 600:2 800:3 900:4 1200:5 1400:6"
      @load-more="loadMore"
    />
  </div>
</template>

<script setup lang="ts">
import { artistVideos } from "@/api/artist";
import type { MVInfo } from "@/types/main.hemusic";
import VideoList from "@/components/List/VideoList.vue";

const props = defineProps<{
  id: string;
  platform: string;
}>();

// 歌曲数据
const loading = ref<boolean>(true);
const hasMore = ref<boolean>(true);
const videoData = ref<MVInfo[]>([]);
const videoPageIndex = ref<number>(1);

// 获取歌手全部视频
const getArtistAllVideos = async () => {
  try {
    if (!props.id || !props.platform) return;
    loading.value = true;
    // 获取数据
    const result = await artistVideos(props.id, props.platform, videoPageIndex.value, 50);
    // 是否还有
    hasMore.value = result?.has_more;
    // 处理数据
    videoData.value = result?.list;
    loading.value = false;
  } catch (error) {
    console.error("Error getting artist all videos:", error);
  }
};

// 加载更多
const loadMore = () => {
  if (hasMore.value) {
    videoPageIndex.value++;
    getArtistAllVideos();
  } else {
    loading.value = false;
  }
};

onMounted(getArtistAllVideos);
</script>
