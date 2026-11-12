<template>
  <div class="batch-list">
    <n-data-table
      :columns="columnsData"
      :data="tableData"
      max-height="60vh"
      virtual-scroll
      @update:checked-row-keys="tableCheck"
    />
    <n-flex class="batch-footer" justify="space-between" align="center">
      <n-text :depth="3" class="count">
        {{ t("modal.already_selected_song_counter", { count: checkCount }) }}
      </n-text>
      <n-flex class="menu">
        <!-- 批量删除 -->
        <n-button
          v-if="playListId || localPlaylistId"
          :disabled="!checkCount || removing"
          type="error"
          strong
          secondary
          :loading="removing"
          @click="removeSelected"
        >
          <template #icon>
            <SvgIcon name="Delete" />
          </template>
          {{ t("modal.delete_selected_songs") }}
        </n-button>
        <!-- 添加到歌单 -->
        <n-button
          :disabled="!checkCount"
          type="primary"
          strong
          secondary
          @click="openPlaylistAdd(checkSongData, isLocal)"
        >
          <template #icon>
            <SvgIcon name="AddList" />
          </template>
          {{ t("menu.add_to_playlist") }}
        </n-button>
      </n-flex>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import type { DataTableColumns, DataTableRowKey } from "naive-ui";
import { isObject } from "lodash-es";
import { openPlaylistAdd } from "@/utils/modal";
import { deleteSongs } from "@/utils/auth";
import { useLocalPlaylistStore } from "@/stores/localPlaylists";
import type { SongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

interface DataType {
  key?: number;
  id?: string;
  platform?: string;
  name?: string;
  artists?: string;
  album?: string;
  // 原始数据
  origin?: SongInfo;
}

const props = defineProps<{
  data: SongInfo[];
  isLocal: boolean;
  playListId?: string;
  localPlaylistId?: string;
}>();

const emit = defineEmits<{ close: [] }>();
const removing = ref(false);
async function removeSelected() {
  if (removing.value || !checkSongData.value.length) return;
  removing.value = true;
  try {
    if (props.localPlaylistId) {
      await useLocalPlaylistStore().removeSongs(
        props.localPlaylistId,
        checkSongData.value.map((song) => song.id),
      );
      emit("close");
    } else if (props.playListId) {
      await deleteSongs(
        props.playListId,
        checkSongData.value.map(({ id, platform }) => ({ id, platform })),
      );
    }
  } catch {
    window.$message.error(t("local_playlists.save_failed"));
  } finally {
    removing.value = false;
  }
}
// 选中数据
const checkCount = ref<number>(0);
const checkSongData = ref<SongInfo[]>([]);

// 表头数据
const columnsData = computed<DataTableColumns<DataType>>(() => [
  {
    type: "selection",
    disabled(row: DataType) {
      return !row.id;
    },
  },
  {
    title: "#",
    key: "key",
    width: 80,
  },
  {
    title: t("common.title"),
    key: "name",
    ellipsis: {
      tooltip: true,
    },
  },
  {
    title: t("common.artist"),
    key: "artists",
    ellipsis: {
      tooltip: true,
    },
  },
  {
    title: t("common.album"),
    key: "album",
    ellipsis: {
      tooltip: true,
    },
  },
]);

// 表格数据
const tableData = computed<DataType[]>(() =>
  props.data.map((song, index) => ({
    key: index + 1,
    id: song?.id,
    platform: song?.platform,
    name: song?.name,
    artists: Array.isArray(song?.artists)
      ? // 拼接歌手
        song?.artists.map((ar: { name: string }) => ar.name).join(" / ")
      : song?.artists || t("common.unknown_artist"),
    album: isObject(song?.album) ? song?.album.name : song?.album || "-",
    // 原始数据
    origin: song,
  })),
);

// 表格勾选
const tableCheck = (keys: DataTableRowKey[], rows: DataType[]) => {
  // 更改选中数量
  checkCount.value = keys.length;
  // 更改选中歌曲
  checkSongData.value = rows.map((row) => row.origin).filter((song) => song) as SongInfo[];
};
</script>

<style lang="scss" scoped>
.batch-footer {
  margin-top: 20px;
}
</style>
