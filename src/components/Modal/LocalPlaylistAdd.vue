<template>
  <AsyncContent :failed="store.failed" :loading="!store.ready && !store.failed" @retry="load">
    <n-scrollbar style="max-height: 70vh">
      <n-list class="playlists-list" hoverable clickable>
        <n-list-item class="playlist add" @click="create">
          <template #prefix><SvgIcon name="Add" :size="20" /></template>
          <n-thing :title="t('modal.create_playlist')" />
        </n-list-item>
        <n-list-item
          v-for="playlist in store.playlists"
          :key="playlist.id"
          class="playlist"
          @click="add(playlist.id)"
        >
          <template #prefix>
            <n-image
              :src="gatewayProxyUrl(playlist.cover || '/images/album.jpg?asset')"
              fallback-src="/images/album.jpg?asset"
              class="cover"
              preview-disabled
              lazy
              @load="coverLoaded"
            />
          </template>
          <n-thing :title="playlist.name">
            <template #description>
              <n-text depth="3">{{
                t("common.song_count", { count: playlist.songs.length })
              }}</n-text>
            </template>
          </n-thing>
        </n-list-item>
      </n-list>
    </n-scrollbar>
  </AsyncContent>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { useLocalPlaylistStore } from "@/stores/localPlaylists";
import { openCreatePlaylist } from "@/utils/modal";
import type { SongInfo } from "@/types/main.hemusic";
import { gatewayProxyUrl } from "@/platform/gateway";
import { coverLoaded } from "@/utils/helper";

const props = defineProps<{ data: SongInfo[]; isLocal: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useLocalPlaylistStore();
const saving = ref(false);
const load = () => void store.load().catch(() => {});
load();

async function add(id: string) {
  if (saving.value) return;
  saving.value = true;
  try {
    await store.add(id, props.data);
    window.$message.success(t("message.add_song_to_playlist_success"));
    emit("close");
  } catch {
    window.$message.error(t("local_playlists.save_failed"));
  } finally {
    saving.value = false;
  }
}
async function create() {
  await openCreatePlaylist({ local: true, songs: props.data });
  emit("close");
}
</script>

<style lang="scss" scoped>
.playlists-list .playlist {
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
  }
}
</style>
