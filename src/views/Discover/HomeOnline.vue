<template>
  <div class="home-online">
    <!-- 公共推荐 -->
    <div v-for="(item, index) in pageData" :key="index" class="rec-public">
      <n-flex
        v-if="loading || item.list.length > 0"
        class="title"
        align="center"
        justify="space-between"
      >
        <n-h3 prefix="bar">
          <n-text>{{ item.name }}</n-text>
          <SvgIcon
            v-if="item.path"
            :size="26"
            name="Right"
            @click="router.push({ name: item.path, query: { platform: platform } })"
          />
        </n-h3>
      </n-flex>
      <!-- 列表 -->
      <AlbumList
        v-if="item.type === 'album' && (loading || item.list.length > 0)"
        :data="item.list"
        :loading="true"
      />
      <VideoList
        v-else-if="item.type === 'video' && (loading || item.list.length > 0)"
        :data="item.list"
        :cols="item.cols"
        :loading="true"
      />
      <PlaylistList
        v-else-if="item.type === 'playlist' && (loading || item.list.length > 0)"
        :data="item.list"
        :loading="true"
      />
      <SongList
        v-else-if="item.type === 'song' && (loading || item.list.length > 0)"
        :data="item.list"
        height="auto"
        :loading="true"
        :show-footer="false"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { NText } from "naive-ui";
import SvgIcon from "@/components/Global/SvgIcon.vue";
import { discoverPage } from "@/api/page";
import type { AlbumInfo, MVInfo, PlaylistInfo, SongInfo } from "@/types/main.hemusic";
import AlbumList from "@/components/List/AlbumList.vue";
import SongList from "@/components/List/SongList.vue";
import VideoList from "@/components/List/VideoList.vue";
import PlaylistList from "@/components/List/PlaylistList.vue";
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const props = defineProps<{
  platform: string;
}>();

const router = useRouter();

interface RecItemType {
  name: ComputedRef<string>;
  list: any[];
  type: string;
  path?: string;
  cols?: string;
}

interface RecDataType {
  new_song: RecItemType;
  new_album: RecItemType;
  featured_mv: RecItemType;
  featured_playlist: RecItemType;
}

const loading = ref(true);

// 推荐数据
const pageData = ref<RecDataType>({
  new_song: {
    name: computed(() => t("discover.new_song")),
    list: [] as SongInfo[],
    type: "song",
    path: "new-song",
  },
  new_album: {
    name: computed(() => t("discover.new_album")),
    list: [] as AlbumInfo[],
    type: "album",
    path: "new-album",
  },
  featured_mv: {
    name: computed(() => t("discover.featured_videos")),
    list: [] as MVInfo[],
    type: "video",
    cols: "2 600:2 800:3 900:4 1200:5 1400:6",
  },
  featured_playlist: {
    name: computed(() => t("discover.featured_playlist")),
    type: "playlist",
    list: [] as PlaylistInfo[],
  },
});

// 获取全部发现数据
const getAllDiscoverData = async () => {
  try {
    const res = await discoverPage(props.platform);
    pageData.value.new_song.list = res.new_songs;
    pageData.value.new_album.list = res.new_albums;
    pageData.value.featured_mv.list = res.featured_mvs;
    pageData.value.featured_playlist.list = res.featured_playlists;
  } catch (error) {
    console.error("Error getting discover page:", error);
  }
  loading.value = false;
};

onMounted(getAllDiscoverData);
</script>

<style lang="scss" scoped>
.home-online {
  width: 100%;
  max-width: 100vw;
  overflow: hidden;
  padding: 0;
  margin: 0;
  box-sizing: border-box;
}

.main-rec {
  .date {
    display: flex;
    align-items: center;
    margin-bottom: 4px;
    .date-icon {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 4px;
      .n-text {
        position: absolute;
        font-size: 12px;
        color: var(--primary-hex);
        line-height: normal;
        margin-top: 4px;
        transform: scale(0.8);
      }
    }
    .name {
      font-size: 18px;
      font-weight: bold;
    }
  }
}
.title {
  margin-top: 10px;
  //padding: 0 16px;
  width: max-content;
  .n-h {
    margin: 0;
    display: flex;
    align-items: center;
    cursor: pointer;
    .n-icon {
      opacity: 0.5;
      transition: opacity 0.3s;
    }
    &:hover {
      .n-icon {
        opacity: 1;
      }
    }
  }
}

.rec-public {
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  margin: 0;
  box-sizing: border-box;
}
</style>
