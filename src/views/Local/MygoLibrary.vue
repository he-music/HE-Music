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
          :disabled="!listData.length || !ready"
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
        <n-tabs
          :value="localType"
          class="tabs"
          type="segment"
          @update:value="(name: string) => router.push({ name })"
        >
          <n-tab name="local-songs">{{ t("common.songs") }}</n-tab>
          <n-tab :disabled="allSongs.length === 0" name="local-artists">
            {{ t("common.artists") }}
          </n-tab>
          <n-tab :disabled="allSongs.length === 0" name="local-albums">
            {{ t("common.albums") }}
          </n-tab>
        </n-tabs>
      </n-flex>
    </n-flex>
    <LocalScanIssues />
    <RouterView v-slot="{ Component }">
      <Transition :name="`router-${settingStore.routeAnimation}`" mode="out-in">
        <KeepAlive v-if="settingStore.useKeepAlive">
          <component :is="Component" :data="listData" :loading="scanning" class="router-view" />
        </KeepAlive>
        <component
          v-else
          :is="Component"
          :data="listData"
          :loading="scanning"
          class="router-view"
        />
      </Transition>
    </RouterView>
  </div>
</template>

<script setup lang="ts">
import { computed, KeepAlive, shallowRef, watch } from "vue";
import LocalScanIssues from "@/components/Local/LocalScanIssues.vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import type { DropdownOption } from "naive-ui";
import { useI18n } from "vue-i18n";
import { useSongSearch } from "@/composables/useSongSearch";
import { filesSession } from "@/platform/filesSession";
import { localFilesSession } from "@/platform/localFilesSession";
import { createLibrarySongRows } from "@/platform/librarySongRows";
import { openBatchList, openLocalMusicDirectoryModal } from "@/utils/modal";
import { renderIcon } from "@/utils/helper";
import { usePlayer } from "@/utils/player";
import { useSettingStore } from "@/stores";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const player = usePlayer();
const session = localFilesSession;
const settingStore = useSettingStore();
const ready = computed(() => filesSession.value?.ready.value ?? false);
const grantCount = computed(() => filesSession.value?.directories.value.length ?? 0);
const scanning = computed(() => session.value?.scanning.value ?? false);
const localType = computed(() => String(route.name ?? "local-songs"));
const query = shallowRef("");
const defaultMusicPath = shallowRef("");
watch(
  () => [filesSession.value, filesSession.value?.ready.value] as const,
  async ([owner], _previous, onCleanup) => {
    let active = true;
    onCleanup(() => {
      active = false;
    });
    defaultMusicPath.value = "";
    if (!owner?.ready.value) return;
    try {
      const result = await owner.defaultDirectory("music");
      if (
        active &&
        filesSession.value === owner &&
        owner.ready.value &&
        result.status === "completed"
      )
        defaultMusicPath.value = result.value?.displayPath ?? "";
    } catch {
      /* Directory suggestions cannot grant access. */
    }
  },
  { immediate: true, flush: "sync" },
);
const entries = computed(() => {
  const owner = filesSession.value;
  if (!owner?.ready.value) return [];
  const paths = new Set(settingStore.localFilesPath);
  if (settingStore.showDefaultLocalPath && defaultMusicPath.value)
    paths.add(defaultMusicPath.value);
  const tokens = new Set(
    owner.directories.value
      .filter((grant) => paths.has(grant.displayPath))
      .map((grant) => grant.token),
  );
  return session.value?.entries.value.filter((entry) => tokens.has(entry.ref.grantToken)) ?? [];
});
const allSongs = createLibrarySongRows(entries);
const searchData = useSongSearch(allSongs, query);
const listData = computed(() => (query.value.trim() ? searchData.value : allSongs.value));

const playFiltered = () => {
  const [first] = listData.value;
  if (first) void player.updatePlayList(listData.value, first);
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
    disabled: !ready.value || !listData.value.length,
    props: { onClick: () => openBatchList(listData.value, true) },
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
.n-alert {
  margin-bottom: 16px;
}
</style>
