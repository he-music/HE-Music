<template>
  <div class="local">
    <div class="title">
      <n-text class="keyword">{{ t("common.local_music") }}</n-text>
      <n-flex class="status">
        <n-text class="item">
          <SvgIcon name="Music" :depth="3" />
          <n-number-animation :from="0" :to="allSongs.length" />
          {{ t("common.song_count_unit", allSongs.length) }}
        </n-text>
        <n-text class="item">
          <SvgIcon name="Storage" :depth="3" />
          <n-number-animation :from="0" :to="allMusicSize" :precision="2" /> GB
        </n-text>
      </n-flex>
    </div>
    <n-flex class="menu" justify="space-between">
      <n-flex class="left" align="center">
        <n-button
          data-library-action="play-filtered"
          :focusable="false"
          :disabled="!songs.length || !ready"
          type="primary"
          strong
          secondary
          round
          @click="playFiltered"
        >
          <template #icon><SvgIcon name="Play" /></template>
          {{ t("common.play") }}
        </n-button>
        <n-button
          data-library-action="scan"
          :focusable="false"
          class="more"
          :disabled="!ready || !grantCount || scanning"
          :loading="scanning"
          :title="t('local.scan_music')"
          :aria-label="t('local.scan_music')"
          strong
          secondary
          circle
          @click="scan"
        >
          <template #icon><SvgIcon name="Refresh" /></template>
        </n-button>
        <n-dropdown :options="moreOptions" trigger="click" placement="bottom-start">
          <n-button
            :focusable="false"
            class="more"
            :title="t('menu.more_operation')"
            :aria-label="t('menu.more_operation')"
            circle
            strong
            secondary
          >
            <template #icon><SvgIcon name="List" /></template>
          </n-button>
        </n-dropdown>
        <n-button v-if="scanning" secondary round @click="session?.cancel()">{{
          t("common.cancel")
        }}</n-button>
      </n-flex>
      <n-flex class="right" justify="end">
        <n-input
          v-model:value="query"
          data-library-filter
          :input-props="{ autocomplete: 'off' }"
          class="search"
          clearable
          round
          :placeholder="t('search.fuzzy_search')"
          :aria-label="t('mygo.library.filter')"
        >
          <template #prefix><SvgIcon name="Search" /></template>
        </n-input>
      </n-flex>
    </n-flex>
    <n-text class="scan-status" role="status">{{
      t(`local.scan_${phase}`, { count: allSongs.length })
    }}</n-text>
    <section v-if="pendingPaths.length" class="directory-recovery">
      <n-text>{{ t("mygo.library.pending") }}</n-text>
      <n-p>{{ t("setting.local.directory_reselect") }}</n-p>
      <p v-for="path in pendingPaths" :key="path">{{ path }}</p>
      <n-button :disabled="!ready" strong secondary @click="openLocalMusicDirectoryModal">
        <template #icon><SvgIcon name="FolderCog" /></template>
        {{ t("local.manage_local_music_folder") }}
      </n-button>
    </section>
    <n-alert v-if="phase === 'partial'" type="warning" :show-icon="false">
      {{ t("local.scan_partial_detail", { count: issueCount }) }}
    </n-alert>
    <n-empty
      v-if="!songs.length && !scanning"
      class="library-empty"
      :description="query.trim() ? t('mygo.library.no_matches') : t('local.scan_empty')"
    />
    <SongList
      v-else
      class="router-view"
      :data="songs"
      :loading="scanning"
      :hidden-cover="!settingStore.showLocalCover"
      :hidden-size="false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, shallowRef } from "vue";
import SongList from "@/components/List/SongList.vue";
import type { DropdownOption } from "naive-ui";
import { renderIcon } from "@/utils/helper";
import { useI18n } from "vue-i18n";
import { filesSession } from "@/platform/filesSession";
import { localFilesSession } from "@/platform/localFilesSession";
import { openBatchList, openLocalMusicDirectoryModal } from "@/utils/modal";
import { usePlayer } from "@/utils/player";
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
const scan = () => void session.value?.scan();
const allMusicSize = computed(() =>
  Number(
    (allSongs.value.reduce((total, song) => total + (song.size || 0), 0) / 1024 ** 3).toFixed(2),
  ),
);
const moreOptions = computed<DropdownOption[]>(() => [
  {
    label: t("local.local_music_folder_manage"),
    key: "folder",
    disabled: !ready.value,
    props: { onClick: () => openLocalMusicDirectoryModal() },
    icon: renderIcon("FolderCog"),
  },
  {
    label: t("common.batch_operation"),
    key: "batch",
    disabled: !ready.value || !songs.value.length,
    props: { onClick: () => openBatchList(songs.value, true) },
    icon: renderIcon("Batch"),
  },
]);
</script>

<style lang="scss" scoped>
.local {
  display: flex;
  flex-direction: column;
  .title {
    display: flex;
    align-items: flex-end;
    line-height: normal;
    margin-top: 12px;
    margin-bottom: 20px;
    height: 40px;
    .keyword {
      font-size: 30px;
      font-weight: bold;
      margin-right: 12px;
      line-height: normal;
    }
    .status {
      font-size: 15px;
      font-weight: normal;
      line-height: 30px;
      .item {
        display: flex;
        align-items: center;
        opacity: 0.9;
        .n-icon {
          margin-right: 4px;
        }
      }
    }
  }
  .menu {
    width: 100%;
    margin-bottom: 20px;
    min-height: 40px;
    height: auto;
    .n-button {
      height: 40px;
      transition: all 0.3s var(--n-bezier);
    }
    .more {
      width: 40px;
    }
    .search {
      height: 40px;
      width: 130px;
      display: flex;
      align-items: center;
      border-radius: 25px;
      transition: all 0.3s var(--n-bezier);
      &.n-input--focus {
        width: 200px;
      }
    }
  }
  .router-view {
    flex: 1;
    overflow: hidden;
    max-height: calc((var(--layout-height) - 132) * 1px);
  }
}
.scan-status {
  margin-bottom: 12px;
}
.directory-recovery,
.n-alert {
  margin-bottom: 16px;
}
.directory-recovery p {
  overflow-wrap: anywhere;
}
.library-empty {
  margin: 60px 0;
}
</style>
