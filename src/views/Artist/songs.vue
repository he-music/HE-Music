<template>
  <div class="artist-songs">
    <SongList
      :data="songData"
      :loading="loading"
      load-more
      @reach-bottom="reachBottom"
      @scroll="emit('scroll', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { artistAllSongs } from "@/api/artist";
import { debounce } from "lodash-es";
import { usePlayer } from "@/utils/player";
import SongList from "@/components/List/SongList.vue";
import type { SongInfo } from "@/types/main.hemusic";

const props = defineProps<{
  id: string;
  platform: string;
}>();

const emit = defineEmits<{
  scroll: [e: Event];
}>();

const player = usePlayer();
// 歌曲数据
const loading = ref<boolean>(true);
const hasMore = ref<boolean>(true);
const songData = ref<SongInfo[]>([]);
const songPageIndex = ref<number>(1);

// 获取歌手全部歌曲
const getArtistAllSongs = async () => {
  try {
    if (!props.id || !props.platform) return;
    loading.value = true;
    // 获取数据
    const result = await artistAllSongs(props.id, props.platform, songPageIndex.value, 50);
    // 是否还有
    hasMore.value = result?.has_more;
    songData.value = songData.value.concat(result.list);
    loading.value = false;
  } catch (error) {
    console.error("Error getting artist all songs:", error);
  }
};

// 播放全部歌曲
const playAllSongs = debounce(() => {
  if (!songData.value || !songData.value?.length) return;
  player.updatePlayList(songData.value);
}, 300);

// 列表触底
const reachBottom = () => {
  if (hasMore.value) {
    songPageIndex.value++;
    getArtistAllSongs();
  } else {
    loading.value = false;
  }
};

defineExpose({ playAllSongs });

onMounted(getArtistAllSongs);
</script>
