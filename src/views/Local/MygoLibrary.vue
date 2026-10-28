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
      <n-text role="status">{{ t(`local.scan_${phase}`, { count: songs.length }) }}</n-text>
    </n-flex>
    <n-p>{{ t("local.scan_supported") }}</n-p>
    <n-alert v-if="phase === 'partial'" type="warning" :show-icon="false">
      {{ t("local.scan_partial_detail", { count: issueCount }) }}
    </n-alert>
    <n-empty v-if="!songs.length && !scanning" :description="t('local.scan_empty')" />
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
import { computed, h } from "vue";
import { NButton, type DataTableColumns } from "naive-ui";
import { useI18n } from "vue-i18n";
import type { SongInfo } from "@/types/main.hemusic";
import { filesSession } from "@/platform/filesSession";
import { localFilesSession } from "@/platform/localFilesSession";
import { openLocalMusicDirectoryModal } from "@/utils/modal";
import { usePlayer } from "@/utils/player";
import { secondsToTime } from "@/utils/time";

const { t } = useI18n();
const player = usePlayer();
const session = localFilesSession;
const ready = computed(() => filesSession.value?.ready.value ?? false);
const grantCount = computed(() => filesSession.value?.directories.value.length ?? 0);
const scanning = computed(() => session.value?.scanning.value ?? false);
const phase = computed(() => session.value?.phase.value ?? "idle");
const issueCount = computed(() => session.value?.issues.value.length ?? 0);
const songs = computed<SongInfo[]>(() =>
  (session.value?.entries.value ?? []).map((entry) => ({
    id: `mygo-local:${entry.ref.fileId}`,
    name: entry.metadata.Title || entry.filename,
    subtitle: "",
    artists: entry.metadata.Artists.join(" / "),
    album: entry.metadata.Album,
    duration: entry.metadata.DurationSeconds,
    path: entry.relativePath,
    size: entry.size,
    mv_id: "",
    platform: "local",
    links: [],
    cover: "/images/song.jpg?asset",
  })),
);
const songKey = (song: SongInfo) => song.id;
const scan = () => void session.value?.scan();
const columns = computed<DataTableColumns<SongInfo>>(() => [
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
