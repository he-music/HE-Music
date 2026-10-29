<template>
  <div class="local-library">
    <n-h1>{{ t("common.local_music") }}</n-h1>
    <n-flex align="center">
      <n-button type="primary" :disabled="!ready" @click="openLocalMusicDirectoryModal">
        {{ t("local.manage_local_music_folder") }}
      </n-button>
      <n-button :disabled="!ready || !grantCount || scanning" @click="scan">
        {{ t("local.scan_music") }}
      </n-button>
      <n-button v-if="scanning" @click="session?.cancel()">{{ t("common.cancel") }}</n-button>
      <n-text role="status">{{ t(`local.scan_${phase}`, { count: allSongs.length }) }}</n-text>
    </n-flex>
    <section v-if="pendingPaths.length">
      <n-text>{{ t("mygo.library.pending") }}</n-text>
      <n-p>{{ t("setting.local.directory_reselect") }}</n-p>
      <p v-for="path in pendingPaths" :key="path">{{ path }}</p>
    </section>
    <n-flex align="center">
      <n-input
        v-model:value="query"
        data-library-filter
        clearable
        :placeholder="t('mygo.library.filter')"
        :aria-label="t('mygo.library.filter')"
      />
      <n-button
        data-library-action="play-filtered"
        :disabled="!songs.length || !ready"
        @click="playFiltered"
      >
        {{ t("mygo.library.play_filtered") }}
      </n-button>
    </n-flex>
    <n-alert v-if="phase === 'partial'" type="warning" :show-icon="false">
      {{ t("local.scan_partial_detail", { count: issueCount }) }}
    </n-alert>
    <n-empty
      v-if="!songs.length && !scanning"
      :description="query.trim() ? t('mygo.library.no_matches') : t('local.scan_empty')"
    />
    <n-data-table
      v-else
      :columns="columns"
      :data="songs"
      :row-key="songKey"
      :max-height="520"
      :loading="scanning"
      virtual-scroll
    />
  </div>
</template>

<script setup lang="ts">
import { computed, h, shallowRef } from "vue";
import LocalSongActions from "@/components/Local/LocalSongActions.vue";
import LocalArtworkImage from "@/components/Local/LocalArtworkImage.vue";
import { NButton, type DataTableColumns } from "naive-ui";
import { useI18n } from "vue-i18n";
import type { SongInfo } from "@/types/main.hemusic";
import { filesSession } from "@/platform/filesSession";
import { localFilesSession } from "@/platform/localFilesSession";
import { openLocalMusicDirectoryModal, openSongInfoEditor } from "@/utils/modal";
import { usePlayer } from "@/utils/player";
import { secondsToTime } from "@/utils/time";
import { createLibraryDirectoryRecovery } from "@/platform/libraryDirectoryRecovery";
import { createLibrarySongRows, filterLibrarySongs } from "@/platform/librarySongRows";
import { useSettingStore } from "@/stores";

const { t } = useI18n();
const player = usePlayer();
const session = localFilesSession;
const ready = computed(() => filesSession.value?.ready.value ?? false);
const grantCount = computed(() => filesSession.value?.directories.value.length ?? 0);
const scanning = computed(() => session.value?.scanning.value ?? false);
const phase = computed(() => session.value?.phase.value ?? "idle");
const issueCount = computed(() => session.value?.issues.value.length ?? 0);
const settingStore = useSettingStore();
const recovery = createLibraryDirectoryRecovery({
  read: () => settingStore.localFilesPath,
  write: (paths) => {
    settingStore.localFilesPath = paths;
  },
});
const pendingPaths = recovery.pendingPaths;
const query = shallowRef("");
const entries = computed(() => session.value?.entries.value ?? []);
const allSongs = createLibrarySongRows(entries);
const songs = computed(() => filterLibrarySongs(allSongs.value, query.value));
const playFiltered = () => {
  const [first] = songs.value;
  if (first) void player.updatePlayList(songs.value, first);
};
const songKey = (song: SongInfo) => song.id;
const scan = () => void session.value?.scan();
const columns = computed<DataTableColumns<SongInfo>>(() => [
  ...(settingStore.showLocalCover
    ? [
        {
          title: "",
          key: "cover",
          width: 56,
          render: (song: SongInfo) =>
            h(
              LocalArtworkImage,
              { song, style: { width: "40px", height: "40px" } },
              {
                default: () =>
                  h("img", { src: "/images/song.jpg?asset", alt: "", width: 40, height: 40 }),
              },
            ),
        },
      ]
    : []),
  { title: t("common.song_name"), key: "name", ellipsis: { tooltip: true } },
  { title: t("common.artist"), key: "artists", ellipsis: { tooltip: true } },
  { title: t("common.album"), key: "album", ellipsis: { tooltip: true } },
  {
    title: t("common.duration"),
    key: "duration",
    width: 90,
    render: (song) => secondsToTime(song.duration),
  },
  {
    title: "",
    key: "play",
    width: 90,
    render: (song) =>
      h(
        NButton,
        { size: "small", onClick: () => void player.updatePlayList(songs.value, song) },
        { default: () => t("common.play") },
      ),
  },
  {
    title: "",
    key: "edit",
    width: 90,
    render: (song) =>
      h(
        NButton,
        {
          size: "small",
          disabled: !ready.value || !filesSession.value?.metadata,
          onClick: () => void openSongInfoEditor(song),
        },
        { default: () => t("modal.song_info_edit") },
      ),
  },
  {
    title: "",
    key: "file-actions",
    width: 48,
    render: (row) => h(LocalSongActions, { song: row }),
  },
]);
</script>

<style scoped lang="scss">
.local-library {
  padding-top: 12px;
}
.n-alert {
  margin-bottom: 16px;
}
</style>
