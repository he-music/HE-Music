<!-- 添加到歌单 -->
<template>
  <div class="playlist-add">
    <n-scrollbar style="max-height: 70vh">
      <n-list class="playlists-list" hoverable clickable>
        <!-- 新建歌单 -->
        <n-list-item class="playlist add" @click="openCreatePlaylist">
          <template #prefix>
            <SvgIcon name="Add" :size="20" />
          </template>
          <n-thing :title="t('modal.create_playlist')" />
        </n-list-item>
        <!-- 已有歌单 -->
        <n-list-item
          v-for="(item, index) in dataStore.userCreatedPlaylist"
          :key="index"
          class="playlist"
          @click="addPlaylist(item)"
        >
          <template #prefix>
            <n-image
              :src="item.cover || '/images/album.jpg?asset'"
              class="cover"
              preview-disabled
              lazy
              @load="coverLoaded"
            >
              <template #placeholder>
                <div class="cover-loading">
                  <img class="loading-img" src="/images/album.jpg?asset" alt="loading-img" />
                </div>
              </template>
            </n-image>
          </template>
          <n-thing :title="index === 0 ? t('playlist.my_favorite_music') : item.name">
            <template #description>
              <n-text depth="3" class="size">
                {{ t("common.song_count", { count: item.song_count }) }}
              </n-text>
            </template>
          </n-thing>
        </n-list-item>
      </n-list>
    </n-scrollbar>
  </div>
</template>

<script setup lang="ts">
import type { MessageReactive } from "naive-ui";
import { useDataStore } from "@/stores";
import { coverLoaded } from "@/utils/helper";
import { debounce } from "lodash-es";
import { updateUserCreatedPlaylist, updateUserLikeSongs } from "@/utils/auth";
import { openCreatePlaylist } from "@/utils/modal";
import type { SongInfo, UserPlaylistInfo } from "@/types/main.hemusic";
import { addSongToPlaylist } from "@/api/userplaylist";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const props = defineProps<{
  data: SongInfo[];
  isLocal: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const dataStore = useDataStore();

// 加载提示
const loadingMsg = ref<MessageReactive>();

// 添加到歌单
const addPlaylist = debounce(
  async (info: UserPlaylistInfo) => {
    loadingMsg.value = window.$message.loading(t("message.adding_song_to_playlist"), {
      duration: 0,
    });
    const ids = props.data
      .map((item) => {
        return {
          id: item.id,
          platform: item.platform,
        };
      })
      .filter((item) => item.id && item.platform);
    if (ids.length === 0) {
      if (loadingMsg.value) loadingMsg.value.destroy();
      return;
    }
    try {
      await addSongToPlaylist(info.id, ids);
      window.$message.success(t("message.add_song_to_playlist_success"));
      emit("close");
      if (info.is_default === 1) await updateUserLikeSongs();
      await updateUserCreatedPlaylist();
    } catch (e: any) {
      window.$message.error(e?.message || t("message.add_fail"));
    }
  },
  500,
  { leading: true, trailing: false },
);
</script>

<style lang="scss" scoped>
.playlists-list {
  .playlist {
    border-radius: 8px;
    :deep(.n-list-item__prefix) {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 50px;
      height: 50px;
      border-radius: 8px;
      background-color: var(--n-border-color);
      overflow: hidden;
      transition: background-color 0.3s;
    }
  }
}
.n-empty {
  padding: 40px 0;
}
</style>
