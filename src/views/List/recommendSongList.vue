<template>
  <div class="recommend-song-list">
    <n-result
      v-if="loadError"
      status="error"
      :title="t('page_section.load_failed')"
      :description="t('page_section.load_failed_description')"
    >
      <template #footer>
        <n-button secondary type="primary" @click="loadSongList">
          {{ t("page_section.retry") }}
        </n-button>
      </template>
    </n-result>

    <template v-else-if="info">
      <div class="detail">
        <div class="cover">
          <n-image
            :src="cover"
            :preview-src="cover"
            :previewed-img-props="{ style: { borderRadius: '8px' } }"
            show-toolbar-tooltip
            class="cover-img"
          />
          <n-image :src="cover" preview-disabled class="cover-shadow" />
        </div>
        <div class="data">
          <n-h2 class="name">
            <n-ellipsis :line-clamp="1" :tooltip="{ placement: 'bottom' }">
              {{ info.title }}
            </n-ellipsis>
          </n-h2>
          <n-ellipsis
            v-if="info.description"
            :line-clamp="2"
            :tooltip="{
              trigger: 'click',
              placement: 'bottom',
              width: 'trigger',
              scrollable: true,
              contentStyle: 'white-space: pre-line; max-height: 400px',
            }"
            class="description"
          >
            {{ info.description }}
          </n-ellipsis>
          <div class="menu">
            <n-flex :wrap="false" class="menu-actions">
              <n-button
                :focusable="false"
                :disabled="!info.songs.length"
                :loading="playLoading"
                type="primary"
                strong
                secondary
                round
                class="play-all"
                @click="playAllSongs"
              >
                <template #icon>
                  <SvgIcon name="Play" />
                </template>
                {{ t("common.play") }}
              </n-button>
              <n-button
                :focusable="false"
                :disabled="!displaySongs.length"
                :aria-label="t('common.batch_operation')"
                :title="t('common.batch_operation')"
                strong
                secondary
                round
                class="batch"
                @click="openBatchList(displaySongs, false)"
              >
                <template #icon>
                  <SvgIcon name="Batch" />
                </template>
                <span class="batch-label">{{ t("common.batch_operation") }}</span>
              </n-button>
            </n-flex>
            <n-input
              v-if="info.songs.length"
              v-model:value="searchValue"
              :input-props="{ autocomplete: 'off' }"
              :placeholder="t('search.fuzzy_search')"
              clearable
              round
              class="search"
              @input="listSearch"
            >
              <template #prefix>
                <SvgIcon name="Search" />
              </template>
            </n-input>
          </div>
        </div>
      </div>

      <SongList
        v-if="!searchValue || displaySongs.length"
        :data="displaySongs"
        height="auto"
        :playlist="{
          id: info.id || targetId,
          platform,
          type: 'recommend-song-list',
        }"
        :show-footer="false"
        :double-click-action="searchValue ? 'add' : 'all'"
        single-click-action
      />
      <n-empty
        v-else
        :description="t('search.no_song_result', { keyword: searchValue })"
        class="search-empty"
        size="large"
      >
        <template #icon>
          <SvgIcon name="SearchOff" />
        </template>
      </n-empty>
    </template>

    <template v-else>
      <div class="detail loading-detail">
        <n-skeleton class="cover" />
        <div class="data">
          <n-skeleton text :repeat="3" />
        </div>
      </div>
      <SongList :data="[]" height="auto" loading :show-footer="false" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { getRecommendSongList } from "@/api/page";
import SongList from "@/components/List/SongList.vue";
import SvgIcon from "@/components/Global/SvgIcon.vue";
import type { RecommendSongListInfo } from "@/types/page";
import { fuzzySearch } from "@/utils/helper";
import { openBatchList } from "@/utils/modal";
import { usePlayer } from "@/utils/player";
import { debounce } from "lodash-es";
import { useI18n } from "vue-i18n";

const route = useRoute();
const player = usePlayer();
const { t } = useI18n();
const info = shallowRef<RecommendSongListInfo | null>(null);
const loadError = ref(false);
const playLoading = ref(false);
const searchValue = ref("");
const searchData = shallowRef<RecommendSongListInfo["songs"]>([]);
let requestSequence = 0;

const platform = computed(() => String(route.query.platform || ""));
const targetId = computed(() => String(route.query.target_id || ""));
const cover = computed(() => info.value?.cover || "/images/album.jpg?asset");
const displaySongs = computed(() =>
  searchValue.value ? searchData.value : info.value?.songs || [],
);

const loadSongList = async () => {
  if (!platform.value || !targetId.value) return;

  const sequence = ++requestSequence;
  info.value = null;
  loadError.value = false;
  searchValue.value = "";
  searchData.value = [];
  try {
    const result = await getRecommendSongList(platform.value, targetId.value);
    if (sequence === requestSequence) info.value = result;
  } catch (error) {
    if (sequence === requestSequence) loadError.value = true;
    console.error("Error getting recommend song list:", error);
  }
};

const listSearch = debounce((value: string) => {
  const keyword = value.trim();
  searchData.value = keyword && info.value ? fuzzySearch(keyword, info.value.songs) : [];
}, 300);

const playAllSongs = async () => {
  if (!info.value?.songs.length || playLoading.value) return;

  playLoading.value = true;
  try {
    await player.updatePlayList(info.value.songs, undefined, {
      id: info.value.id || targetId.value,
      platform: platform.value,
      type: "recommend-song-list",
    });
  } finally {
    playLoading.value = false;
  }
};

watch([platform, targetId], loadSongList, { immediate: true });
</script>

<style lang="scss" scoped>
.recommend-song-list {
  width: 100%;
  min-width: 0;

  > .n-result {
    margin-top: 72px;
  }
}

.detail {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 24px;
  min-height: 216px;
  padding: 12px 4px 24px;
}

.cover {
  position: relative;
  width: 180px;
  height: 180px;
  border-radius: 8px;

  .cover-img {
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: 8px;
    z-index: 1;

    :deep(img) {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  }

  .cover-shadow {
    position: absolute;
    top: 7px;
    left: 0;
    width: 100%;
    height: 100%;
    filter: blur(12px) opacity(0.5);
    transform: scale(0.92, 0.96);
    z-index: 0;

    :deep(img) {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  }
}

.data {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  padding: 8px 0;

  .name {
    width: 100%;
    margin: 0 0 12px;
    font-size: 26px;
  }

  .description {
    max-width: 760px;
    cursor: pointer;
  }

  .menu {
    display: flex;
    width: 100%;
    margin-top: auto;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .play-all {
    min-width: 96px;
  }

  .search {
    width: 180px;
  }

  :deep(.n-skeleton) {
    height: 30px;
    margin-bottom: 12px;
    border-radius: 8px;
  }
}

.loading-detail .cover {
  overflow: hidden;
}

.search-empty {
  margin-top: 48px;
}

@media (max-width: 600px) {
  .detail {
    grid-template-columns: 104px minmax(0, 1fr);
    gap: 14px;
    min-height: 136px;
    padding-bottom: 20px;
  }

  .cover {
    width: 104px;
    height: 104px;
  }

  .data {
    padding: 2px 0;

    .name {
      margin-bottom: 6px;
      font-size: 20px;
    }

    .description {
      font-size: 13px;
    }

    .play-all {
      min-width: 84px;
      height: 32px;
    }

    .menu {
      flex-wrap: wrap;
      gap: 8px;
    }

    .batch {
      width: 32px;
      height: 32px;
      padding: 0;
    }

    .batch-label {
      display: none;
    }

    .search {
      width: 100%;
      height: 32px;
    }
  }
}
</style>
