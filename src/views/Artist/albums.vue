<template>
  <div class="artist-type">
    <AlbumList
      :data="albumData"
      :loading="loading"
      :load-more="hasMore"
      type="album"
      @load-more="loadMore"
    />
  </div>
</template>

<script setup lang="ts">
import { artistAlbums } from "@/api/artist";
import type { AlbumInfo } from "@/types/main.hemusic";
import AlbumList from "@/components/List/AlbumList.vue";

const props = defineProps<{
  id: string;
  platform: string;
}>();

// 歌曲数据
const loading = ref<boolean>(true);
const hasMore = ref<boolean>(true);
const albumData = ref<AlbumInfo[]>([]);
const albumPageIndex = ref<number>(1);

// 获取歌手全部专辑
const getArtistAllAlbums = async () => {
  try {
    if (!props.id || !props.platform) return;
    loading.value = true;
    // 获取数据
    const result = await artistAlbums(props.id, props.platform, albumPageIndex.value, 50);
    // 是否还有
    hasMore.value = result?.has_more;
    albumData.value = albumData.value.concat(result.list);
    loading.value = false;
  } catch (error) {
    console.error("Error getting artist all albums:", error);
  }
};

// 加载更多
const loadMore = () => {
  if (hasMore.value) {
    albumPageIndex.value++;
    getArtistAllAlbums();
  } else {
    loading.value = false;
  }
};

onMounted(getArtistAllAlbums);
</script>
