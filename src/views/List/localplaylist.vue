<template>
  <div
    :ref="detailPageRef"
    :class="[
      'playlist',
      'local-playlist',
      { small: listScrolling, 'mobile-detail': isSmallScreen },
    ]"
  >
    <AsyncContent :failed="store.failed" :loading="!store.ready" @retry="load">
      <template v-if="playlist">
        <MobileMusicDetailHeader
          v-if="isSmallScreen"
          v-model:search="search"
          :title="playlist.name"
          :cover="playlist.cover || fallbackCover"
          :subtitle="t('local_playlists.title')"
          :description="playlist.description || t('playlist.empty_description')"
          :searchable="!!songs.length"
          @play="playAll"
        >
          <template #meta
            ><n-text depth="3">{{
              t("common.song_count", { count: songs.length })
            }}</n-text></template
          >
          <template #actions>
            <n-button circle secondary :aria-label="t('common.edit')" @click="edit">
              <template #icon><SvgIcon name="EditNote" /></template>
            </n-button>
            <n-dropdown :options="moreOptions" trigger="click" placement="bottom-end">
              <n-button circle secondary :aria-label="t('common.more')">
                <template #icon><SvgIcon name="More" /></template>
              </n-button>
            </n-dropdown>
          </template>
        </MobileMusicDetailHeader>
        <div v-else class="detail">
          <div class="cover">
            <n-image
              :src="cover"
              :fallback-src="fallbackCover"
              :preview-src="cover"
              :previewed-img-props="{ style: { borderRadius: '8px' } }"
              :render-toolbar="renderToolbar"
              :alt="playlist.name"
              show-toolbar-tooltip
              class="cover-img"
              object-fit="cover"
              @load="coverLoaded"
            >
              <template #placeholder>
                <div class="cover-loading">
                  <img :src="fallbackCover" class="loading-img" alt="" />
                </div>
              </template>
            </n-image>
            <n-image
              class="cover-shadow"
              object-fit="cover"
              :src="cover"
              :fallback-src="fallbackCover"
              preview-disabled
            />
            <div class="cover-mask" />
          </div>
          <div class="data">
            <n-h2 class="name text-hidden">{{ playlist.name }}</n-h2>
            <n-collapse-transition :show="!listScrolling" class="collapse">
              <n-text class="description text-hidden" @click="openDescModal(description)">
                {{ description }}
              </n-text>
              <n-flex class="meta">
                <div class="item">
                  <SvgIcon name="FolderMusic" :depth="3" /><n-text>{{
                    t("local_playlists.title")
                  }}</n-text>
                </div>
                <div class="item">
                  <SvgIcon name="Music" :depth="3" /><n-text>{{ songs.length }}</n-text>
                </div>
                <div v-if="playlist.createdAt" class="item">
                  <SvgIcon name="Time" :depth="3" /><n-text>{{
                    formatTimestamp(playlist.createdAt)
                  }}</n-text>
                </div>
              </n-flex>
            </n-collapse-transition>
            <n-flex class="menu" justify="space-between">
              <n-flex class="left" align="flex-end">
                <n-button
                  :disabled="!playable.length"
                  type="primary"
                  strong
                  secondary
                  round
                  @click="playAll"
                >
                  <template #icon><SvgIcon name="Play" /></template>{{ t("common.play") }}
                </n-button>
                <n-button strong secondary round @click="edit">
                  <template #icon><SvgIcon name="EditNote" /></template>{{ t("common.edit") }}
                </n-button>
                <n-dropdown :options="moreOptions" trigger="click" placement="bottom-start">
                  <n-button class="more" circle strong secondary :aria-label="t('common.more')">
                    <template #icon><SvgIcon name="List" /></template>
                  </n-button>
                </n-dropdown>
              </n-flex>
              <n-input
                v-if="songs.length"
                v-model:value="search"
                :input-props="{ autocomplete: 'off', 'aria-label': t('search.fuzzy_search') }"
                :placeholder="t('search.fuzzy_search')"
                class="search"
                clearable
                round
                ><template #prefix><SvgIcon name="Search" /></template
              ></n-input>
            </n-flex>
          </div>
        </div>
      </template>
      <div v-else-if="!store.ready" class="detail">
        <n-skeleton class="cover" />
        <div class="data"><n-skeleton :repeat="4" text /></div>
      </div>
    </AsyncContent>
    <SongList
      v-if="playlist && visibleSongs.length"
      :data="visibleSongs"
      :playlist="playlistContext"
      :height="listHeight"
      :single-click-action="isSmallScreen"
      :unavailable-song-ids="unavailableSongIDs"
      :show-footer="false"
      @scroll="listScroll"
    >
      <template #tags="{ song }">
        <n-tag
          v-if="unavailableSongIDs.has(song.id)"
          size="small"
          :bordered="false"
          type="warning"
          round
        >
          {{ t("local_playlists.unavailable") }}
        </n-tag>
      </template>
      <template #details="{ song }">
        <n-button
          v-if="unavailableSongIDs.has(song.id)"
          text
          size="small"
          @click.stop="relink(song)"
        >
          {{ t("local_playlists.relink") }}
        </n-button>
      </template>
    </SongList>
    <n-empty
      v-else-if="store.ready && !store.failed"
      :description="
        !playlist
          ? t('local_playlists.not_found')
          : search
            ? t('search.no_song_result', { keyword: search })
            : t('play.no_songs')
      "
      size="large"
    >
      <template v-if="playlist && !songs.length" #extra>
        <n-button secondary @click="router.push({ name: 'local' })">{{
          t("common.local_music")
        }}</n-button>
      </template>
    </n-empty>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onDeactivated, onScopeDispose, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { NSelect, type DropdownOption, type ModalReactive } from "naive-ui";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import MobileMusicDetailHeader from "@/components/Page/MobileMusicDetailHeader.vue";
import SongList from "@/components/List/SongList.vue";
import { useMusicDetailLayout } from "@/composables/useMusicDetailLayout";
import { useSongSearch } from "@/composables/useSongSearch";
import { useLibrarySync } from "@/composables/useLibrarySync";
import { useLocalPlaylistStore } from "@/stores/localPlaylists";
import { useStatusStore } from "@/stores/status";
import { localFilesSession } from "@/platform/localFilesSession";
import { createLibrarySongRows } from "@/platform/librarySongRows";
import { gatewayProxyUrl } from "@/platform/gateway";
import { coverLoaded, renderIcon } from "@/utils/helper";
import { openBatchList, openDescModal, openUpdateLocalPlaylist } from "@/utils/modal";
import { renderToolbar } from "@/utils/meta";
import { formatTimestamp } from "@/utils/time";
import { usePlayer } from "@/utils/player";
import type { SongInfo } from "@/types/main.hemusic";

const { t } = useI18n();
const { isSmallScreen, detailPageRef } = useMusicDetailLayout();
const store = useLocalPlaylistStore();
const status = useStatusStore();
const router = useRouter();
const player = usePlayer();
const playlistID = ref("");
const search = ref("");
const listScrolling = ref(false);
const fallbackCover = "/images/album.jpg?asset";
const playlist = computed(() => store.playlists.find((item) => item.id === playlistID.value));
const cover = computed(() => gatewayProxyUrl(playlist.value?.cover || fallbackCover));
const description = computed(() => playlist.value?.description || t("playlist.empty_description"));
const currentSongs = createLibrarySongRows(
  computed(() => localFilesSession.value?.entries.value ?? []),
);
const byID = computed(() => new Map(currentSongs.value.map((song) => [song.id, song])));
const songs = computed(
  () => playlist.value?.songs.map((song) => byID.value.get(song.id) ?? song) ?? [],
);
const unavailableSongIDs = computed(
  () => new Set(songs.value.filter((song) => !byID.value.has(song.id)).map((song) => song.id)),
);
const searchResults = useSongSearch(songs, search);
const visibleSongs = computed(() => (search.value.trim() ? searchResults.value : songs.value));
const playable = computed(() =>
  visibleSongs.value.filter((song) => !unavailableSongIDs.value.has(song.id)),
);
const playlistContext = computed(() => ({
  id: playlistID.value,
  platform: "",
  type: "local-playlist",
}));
const listHeight = computed<number | "auto">(() =>
  isSmallScreen.value
    ? "auto"
    : Math.max(160, status.mainContentHeight - (listScrolling.value ? 120 : 240)),
);
const load = () => void store.load().catch(() => {});
let repairModal: ModalReactive | undefined;
let active = true;
useLibrarySync();
load();
watch(
  () => router.currentRoute.value,
  (route) => {
    if (route.name !== "local-playlist") return;
    const id = typeof route.query.id === "string" ? route.query.id : "";
    if (id !== playlistID.value) {
      repairModal?.destroy();
      playlistID.value = id;
      search.value = "";
      listScrolling.value = false;
    }
  },
  { immediate: true },
);
onDeactivated(() => repairModal?.destroy());
onScopeDispose(() => {
  active = false;
  repairModal?.destroy();
});

function listScroll(event: Event) {
  if (!isSmallScreen.value && event.target instanceof HTMLElement)
    listScrolling.value = event.target.scrollTop > 10;
}
function playAll() {
  if (playable.value.length)
    void player.updatePlayList(playable.value, undefined, playlistContext.value);
}
function edit() {
  if (playlist.value) void openUpdateLocalPlaylist(playlist.value);
}
function remove() {
  const selected = playlist.value;
  if (!selected) return;
  window.$dialog.warning({
    title: t("common.delete_playlist"),
    content: t("local_playlists.delete_confirm", { name: selected.name }),
    positiveText: t("common.delete"),
    negativeText: t("common.cancel"),
    onPositiveClick: async () => {
      try {
        await store.remove(selected.id);
        if (
          active &&
          playlistID.value === selected.id &&
          router.currentRoute.value.name === "local-playlist"
        ) {
          void router.replace({ name: "local" });
        }
        return true;
      } catch {
        if (active) window.$message.error(t("local_playlists.save_failed"));
        return false;
      }
    },
  });
}
function relink(previous: SongInfo) {
  const id = playlistID.value;
  repairModal?.destroy();
  const modal = window.$modal.create({
    preset: "card",
    title: t("local_playlists.relink"),
    style: { width: "600px", maxWidth: "calc(100vw - 32px)" },
    content: () =>
      h(NSelect, {
        value: null,
        filterable: true,
        placeholder: t("common.songs"),
        options: currentSongs.value.map((song) => ({
          value: song.id,
          label: `${song.name} · ${song.artists}`,
          disabled: playlist.value?.songs.some((saved) => saved.id === song.id),
        })),
        onUpdateValue: async (value: string | null) => {
          const song = byID.value.get(value ?? "");
          if (!active || !song || playlistID.value !== id) return;
          try {
            await store.replace(id, previous.id, song);
            modal.destroy();
          } catch {
            if (active) window.$message.error(t("local_playlists.save_failed"));
          }
        },
      }),
    onAfterLeave: () => {
      if (repairModal === modal) repairModal = undefined;
    },
  });
  repairModal = modal;
}
const moreOptions = computed<DropdownOption[]>(() => [
  {
    key: "batch",
    label: t("common.batch_operation"),
    disabled: !songs.value.length,
    icon: renderIcon("Batch"),
    props: { onClick: () => openBatchList(visibleSongs.value, true, undefined, playlistID.value) },
  },
  {
    key: "delete",
    label: t("common.delete_playlist"),
    icon: renderIcon("Delete"),
    props: { onClick: remove },
  },
]);
</script>

<style lang="scss" scoped>
@use "@/style/playlist-detail";
</style>
