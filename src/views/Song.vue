<template>
  <div class="song-page">
    <Transition name="fade" mode="out-in">
      <div v-if="songData" class="hero">
        <div class="hero-main">
          <SongDataCard :data="songData" can-jump />
          <div class="hero-actions">
            <n-button :focusable="false" type="primary" strong secondary round @click="playSongNow">
              <template #icon>
                <SvgIcon name="Play" />
              </template>
              {{ t("common.play") }}
            </n-button>
            <n-button
              :focusable="false"
              strong
              secondary
              round
              @click="toLikeSong(songData, !dataStore.isLikeSong(songData))"
            >
              <template #icon>
                <SvgIcon :name="dataStore.isLikeSong(songData) ? 'Favorite' : 'FavoriteBorder'" />
              </template>
              {{
                dataStore.isLikeSong(songData) ? t("common.cancel_collect") : t("common.collect")
              }}
            </n-button>
            <n-dropdown :options="moreOptions" trigger="click" placement="bottom-start">
              <n-button :focusable="false" class="more-btn" strong secondary round>
                <template #icon>
                  <SvgIcon name="List" />
                </template>
                {{ t("menu.more_operation") }}
              </n-button>
            </n-dropdown>
          </div>
          <div class="meta-list">
            <div class="meta-item">
              <span class="label">{{ t("common.platform") }}</span>
              <span class="value">{{ platformName }}</span>
            </div>
            <div class="meta-item">
              <span class="label">{{ t("common.publish_time") }}</span>
              <span class="value">{{ publishTimeText }}</span>
            </div>
            <div class="meta-item">
              <span class="label">{{ t("common.language") }}</span>
              <span class="value">{{ metadata?.language || "-" }}</span>
            </div>
            <div class="meta-item">
              <span class="label">{{ t("common.duration") }}</span>
              <span class="value">{{ secondsToTime(songData.duration) }}</span>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="hero loading">
        <n-skeleton class="hero-skeleton" />
      </div>
    </Transition>

    <n-flex v-if="supportSongRelations" vertical :size="20" class="sections">
      <section v-if="similarSongs.length" class="section">
        <n-h3 prefix="bar">{{ t("common.similar_songs") }}</n-h3>
        <SongList
          :data="similarSongs"
          :loading="relationsLoading"
          height="auto"
          :show-footer="false"
          :disabled-sort="true"
        />
      </section>

      <section v-if="otherVersionSongs.length" class="section">
        <n-h3 prefix="bar">{{ t("common.other_versions") }}</n-h3>
        <SongList
          :data="otherVersionSongs"
          :loading="relationsLoading"
          height="auto"
          :show-footer="false"
          :disabled-sort="true"
          hidden-album
        />
      </section>

      <section v-if="relatedPlaylists.length" class="section">
        <n-h3 prefix="bar">{{ t("common.related_playlists") }}</n-h3>
        <PlaylistList :data="relatedPlaylists" />
      </section>

      <section v-if="relatedMvs.length" class="section">
        <n-h3 prefix="bar">{{ t("common.related_videos") }}</n-h3>
        <VideoList :data="relatedMvs" />
      </section>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import type { DropdownOption } from "naive-ui";
import { songDetail, songRelations } from "@/api/song";
import type { MVInfo, PlaylistInfo, SongInfo, SongMetadata } from "@/types/main.hemusic";
import SongDataCard from "@/components/Card/SongDataCard.vue";
import SongList from "@/components/List/SongList.vue";
import PlaylistList from "@/components/List/PlaylistList.vue";
import VideoList from "@/components/List/VideoList.vue";
import { FeatureSupportFlag } from "@/api/platform";
import { useDataStore, usePlatformStore, useStatusStore } from "@/stores";
import { secondsToTime, formatTimestamp } from "@/utils/time";
import { usePlayer } from "@/utils/player";
import { toLikeSong } from "@/utils/auth";
import { buildSourceUrl } from "@/api/source";
import { copyData, getShareUrl, renderIcon } from "@/utils/helper";
import { getSizeCover } from "@/utils/format";
import { openDownloadSong, openPlaylistAdd } from "@/utils/modal";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const router = useRouter();
const player = usePlayer();
const dataStore = useDataStore();
const statusStore = useStatusStore();
const platformStore = usePlatformStore();

const routeName = computed(() => String(router.currentRoute.value.name || ""));
const songId = computed<string>(() => String(router.currentRoute.value.query.id || ""));
const platform = computed<string>(() => String(router.currentRoute.value.query.platform || ""));

const relationsLoading = ref<boolean>(true);
const songData = ref<SongInfo | null>(null);
const metadata = ref<SongMetadata | null>(null);
const similarSongs = ref<SongInfo[]>([]);
const otherVersionSongs = ref<SongInfo[]>([]);
const relatedPlaylists = ref<PlaylistInfo[]>([]);
const relatedMvs = ref<MVInfo[]>([]);

const platformName = computed(() => {
  return platformStore.getPlatformInfo(platform.value)?.name || platform.value || "-";
});

const supportSongRelations = computed(() => {
  if (!platform.value) return false;
  return platformStore.isFeatureSupport(platform.value, FeatureSupportFlag.ListSongRelations);
});

const publishTimeText = computed(() => {
  if (!metadata.value?.publish_time) return "-";
  return formatTimestamp(Number(metadata.value.publish_time) * 1000);
});

const hasMv = computed(() => {
  return !!songData.value?.mv_id && songData.value.mv_id !== "0";
});

const moreOptions = computed<DropdownOption[]>(() => [
  {
    key: "play-next",
    label: t("menu.play_next"),
    props: {
      onClick: () => playSongNext(),
    },
    icon: renderIcon("PlayNext", { size: 18 }),
  },
  {
    key: "playlist-add",
    label: t("menu.add_to_playlist"),
    props: {
      onClick: () => songData.value && openPlaylistAdd([songData.value], false),
    },
    icon: renderIcon("AddList", { size: 18 }),
  },
  {
    key: "mv",
    label: t("menu.watch_mv"),
    show: !!songData.value && hasMv.value,
    props: {
      onClick: () =>
        songData.value &&
        router.push({
          name: "video",
          query: { id: songData.value.mv_id, platform: songData.value.platform },
        }),
    },
    icon: renderIcon("Video", { size: 18 }),
  },
  {
    key: "download",
    label: t("common.download_song"),
    props: {
      onClick: () => songData.value && openDownloadSong(songData.value),
    },
    icon: renderIcon("Download", { size: 18 }),
  },
  {
    key: "comment",
    label: t("menu.view_comment"),
    show:
      !!songData.value &&
      platformStore.isFeatureSupport(songData.value.platform, FeatureSupportFlag.GetCommentList),
    props: {
      onClick: () => openComment(),
    },
    icon: renderIcon("Message", { size: 18 }),
  },
  {
    key: "divider-1",
    type: "divider",
  },
  {
    key: "copy-id",
    label: t("menu.copy_song_id"),
    props: {
      onClick: () => songData.value && copyData(songData.value.id),
    },
    icon: renderIcon("Copy", { size: 18 }),
  },
  {
    key: "copy-name",
    label: t("menu.copy_song_name"),
    props: {
      onClick: () => songData.value && copyData(songData.value.name),
    },
    icon: renderIcon("Copy", { size: 18 }),
  },
  {
    key: "share",
    label: t("menu.copy_share_link"),
    props: {
      onClick: async () => {
        const url = getShareUrl("song", songId.value, platform.value);
        copyData(url, t("menu.share_link_copied"));
      },
    },
    icon: renderIcon("Share", { size: 18 }),
  },
  {
    key: "source",
    label: t("common.open_source_page"),
    show:
      !!songData.value &&
      platformStore.isFeatureSupport(platform.value, FeatureSupportFlag.BuildSourceUrl),
    props: {
      onClick: async () => {
        if (!songData.value) return;
        const { url } = await buildSourceUrl(platform.value, songData.value.id, "song");
        window.open(url);
      },
    },
    icon: renderIcon("Link", { size: 18 }),
  },
]);

const playSongNow = () => {
  if (!songData.value) return;
  player.updatePlayList([songData.value], songData.value, {
    id: songData.value.id,
    platform: songData.value.platform,
    type: "song",
  });
};

const playSongNext = () => {
  if (!songData.value) return;
  player.addNextSong(songData.value, false);
};

const openComment = () => {
  if (!songData.value) return;
  statusStore.commentConfig = {
    id: songData.value.id,
    name: songData.value.name,
    creator: Array.isArray(songData.value.artists)
      ? songData.value.artists.map((item) => item.name).join(" / ")
      : String(songData.value.artists),
    platform: songData.value.platform,
    cover: getSizeCover(songData.value, 300),
    resource_type: "song",
  };
  router.push({ name: "comment" });
};

const getSongDetail = async () => {
  try {
    if (routeName.value !== "song" || !songId.value || !platform.value) return;
    const result = await songDetail(songId.value, platform.value);
    if (result.song?.path) {
      window.$message.warning(t("message.local_song_not_support_operation"));
      router.replace({ name: "discover" });
      return;
    }
    songData.value = result.song;
    metadata.value = result.metadata;
  } catch (error) {
    console.error("Error getting song detail:", error);
    window.$message.error(t("message.get_song_detail_fail"));
  } finally {
  }
};

const getSongRelations = async () => {
  try {
    if (routeName.value !== "song" || !songId.value || !platform.value) return;
    relationsLoading.value = true;
    const result = await songRelations(songId.value, platform.value);
    similarSongs.value = result.similar_songs || [];
    otherVersionSongs.value = result.other_version_songs || [];
    relatedPlaylists.value = result.related_playlists || [];
    relatedMvs.value = result.related_mvs || [];
  } catch (error) {
    console.error("Error getting song relations:", error);
    window.$message.error(t("message.get_song_relations_fail"));
  } finally {
    relationsLoading.value = false;
  }
};

const loadSongPage = async () => {
  if (routeName.value !== "song") return;
  songData.value = null;
  metadata.value = null;
  similarSongs.value = [];
  otherVersionSongs.value = [];
  relatedPlaylists.value = [];
  relatedMvs.value = [];

  if (!supportSongRelations.value) {
    relationsLoading.value = false;
    await getSongDetail();
    return;
  }

  await Promise.all([getSongDetail(), getSongRelations()]);
};

watch(
  [routeName, songId, platform],
  () => {
    loadSongPage();
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
.song-page {
  padding: 20px 4px 32px;

  .hero {
    margin-bottom: 24px;

    &.loading {
      display: block;
    }
  }

  .hero-skeleton {
    width: 100%;
    height: 220px;
    border-radius: 18px;
  }

  .hero-main {
    min-width: 0;
  }

  .meta-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin-top: 16px;
  }

  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 16px;
  }

  .meta-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 16px;
    border-radius: 14px;
    background: var(--surface-container-hex);
    font-size: 14px;

    .label {
      opacity: 0.6;
    }

    .value {
      font-weight: 600;
    }
  }

  .more-btn {
    min-width: 108px;
  }

  .sections {
    width: 100%;
  }

  .section {
    min-width: 0;
  }
}
</style>
