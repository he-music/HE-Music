<template>
  <div class="local-albums">
    <n-scrollbar class="album-list">
      <n-card
        v-for="[key, item] in albumData"
        :id="key"
        :key="key"
        :class="['album-item', { choose: chooseAlbum === key }]"
        @click="chooseAlbum = key"
      >
        <Transition name="fade" mode="out-in">
          <n-image
            :key="item?.[0]?.cover"
            v-visible.once="(show: boolean) => loadAlbumCover(show, key)"
            :src="item?.[0]?.cover || '/images/album.jpg?asset'"
            preview-disabled
            class="cover"
          />
        </Transition>
        <div class="data">
          <n-text class="name">
            {{ key }}
          </n-text>
          <n-text class="num" depth="3">
            <SvgIcon name="Music" :depth="3" />
            {{ t("common.song_counter", { count: item.length }) }}
          </n-text>
        </div>
      </n-card>
    </n-scrollbar>
    <Transition name="fade" mode="out-in">
      <SongList :key="chooseAlbum" :data="selectedSongs" :loading="true" hidden-cover />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { groupSongs } from "@/utils/songGroup";
import blob from "@/utils/blob";
import type { SongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const props = defineProps<{ data: SongInfo[] }>();

// 专辑数据
const chooseAlbum = ref<string>("");
const albumData = computed(() =>
  groupSongs(props.data, (song) => [
    typeof song.album === "string" ? song.album.trim() : song.album.name,
  ]),
);
const selectedSongs = computed(() => albumData.value.get(chooseAlbum.value) ?? []);

watch(
  albumData,
  (groups) => {
    if (!groups.has(chooseAlbum.value)) chooseAlbum.value = groups.keys().next().value ?? "";
  },
  { immediate: true },
);

// 加载专辑封面
const loadAlbumCover = async (show: boolean, key: string) => {
  if (!show) return;
  const song = albumData.value.get(key)?.[0];
  if (!song?.path) return;
  const coverData = await window.electron.ipcRenderer.invoke("get-music-cover", song.path);
  if (!coverData) return;
  const { data, format } = coverData;
  const blobURL = blob.createBlobURL(data, format, song.path);
  if (blobURL) song.cover = blobURL;
};

watch(
  () => chooseAlbum.value,
  (val) => {
    if (!val) return;
    const artistDom = document.getElementById(val);
    if (artistDom) artistDom.scrollIntoView({ behavior: "smooth", block: "center" });
  },
);
</script>

<style lang="scss" scoped>
.local-albums {
  display: flex;
  height: calc((var(--layout-height) - 80) * 1px);
  :deep(.album-list) {
    width: 260px;
    .n-scrollbar-content {
      padding: 0 5px 0 0 !important;
    }
  }
  .album-item {
    margin-bottom: 8px;
    border-radius: 8px;
    height: max-content;
    border: 2px solid rgba(var(--primary), 0.12);
    cursor: pointer;
    :deep(.n-card-content) {
      display: flex;
      padding: 12px;
    }
    &:last-child {
      margin-bottom: 24px;
    }
    .cover {
      width: 50px;
      height: 50px;
      margin-right: 12px;
      border-radius: 12px;
      overflow: hidden;
      :deep(img) {
        width: 100%;
        height: 100%;
      }
    }
    .data {
      display: flex;
      flex-direction: column;
      flex: 1;
      .name {
        font-weight: bold;
        font-size: 16px;
      }
      .num {
        margin-top: 2px;
        display: flex;
        align-items: center;
        .n-icon {
          margin-right: 2px;
          margin-top: -2px;
        }
      }
    }
    &:hover {
      border-color: rgba(var(--primary), 0.58);
    }
    &.choose {
      border-color: rgba(var(--primary), 0.58);
      background-color: rgba(var(--primary), 0.28);
    }
  }
  .song-list {
    width: 100%;
    flex: 1;
    margin-left: 15px;
  }
}
</style>
