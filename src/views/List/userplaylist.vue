<!-- 歌单列表 -->
<template>
  <div :class="['playlist', { small: listScrolling }]">
    <Transition name="fade" mode="out-in">
      <div v-if="playlistDetailData" class="detail">
        <div class="cover">
          <n-image
            :src="playlistDetailData.cover"
            :previewed-img-props="{ style: { borderRadius: '8px' } }"
            :preview-src="playlistDetailData.cover"
            :render-toolbar="renderToolbar"
            show-toolbar-tooltip
            class="cover-img"
            @load="coverLoaded"
          >
            <template #placeholder>
              <div class="cover-loading">
                <img src="/images/album.jpg?asset" class="loading-img" alt="loading-img" />
              </div>
            </template>
          </n-image>
          <!-- 封面背板 -->
          <n-image class="cover-shadow" preview-disabled :src="playlistDetailData.cover" />
          <!-- 遮罩 -->
          <div class="cover-mask" />
        </div>
        <div class="data">
          <n-h2 class="name text-hidden">
            {{
              playlistDetailData.is_default == 1
                ? t("playlist.my_favorite_music")
                : playlistDetailData.name || t("common.unknown_playlist")
            }}
          </n-h2>
          <n-collapse-transition :show="!listScrolling" class="collapse">
            <!-- 简介 -->
            <n-text
              v-if="playlistDetailData.description || t('playlist.empty_description')"
              class="description text-hidden"
              @click="
                openDescModal(playlistDetailData.description || t('playlist.empty_description'))
              "
            >
              {{ playlistDetailData.description || t("playlist.empty_description") }}
            </n-text>
            <!-- 信息 -->
            <n-flex class="meta">
              <div class="item">
                <SvgIcon name="Person" :depth="3" />
                <n-text>{{ playlistDetailData.creator || t("common.unknown_user") }}</n-text>
              </div>
              <div class="item">
                <SvgIcon name="Music" :depth="3" />
                <n-text>{{ playlistDetailData.song_count || 0 }}</n-text>
              </div>
              <!--              <div v-if="playlistDetailData.updateTime" class="item">-->
              <!--                <SvgIcon name="Update" :depth="3" />-->
              <!--                <n-text>{{ formatTimestamp(playlistDetailData.updateTime) }}</n-text>-->
              <!--              </div>-->
              <div v-if="playlistDetailData.created_at" class="item">
                <SvgIcon name="Time" :depth="3" />
                <n-text>{{ formatTimestamp(Number(playlistDetailData.created_at) * 1000) }}</n-text>
              </div>
            </n-flex>
          </n-collapse-transition>
          <n-flex class="menu" justify="space-between">
            <n-flex class="left" align="flex-end">
              <n-button
                :focusable="false"
                :disabled="songLoading"
                :loading="songLoading"
                type="primary"
                strong
                secondary
                round
                @click="playAllSongs"
              >
                <template #icon>
                  <SvgIcon name="Play" />
                </template>
                {{
                  songLoading
                    ? `${t("common.loading")}... (${
                        playlistData.length === Number(playlistDetailData.song_count)
                          ? 0
                          : playlistData.length
                      }/${playlistDetailData.song_count})`
                    : t("common.play")
                }}
              </n-button>
              <n-button :focusable="false" strong secondary round @click="updatePlaylist">
                <template #icon>
                  <SvgIcon name="EditNote" />
                </template>
                {{ t("common.edit") }}
              </n-button>
              <!-- 更多 -->
              <n-dropdown :options="moreOptions" trigger="click" placement="bottom-start">
                <n-button :focusable="false" class="more" circle strong secondary>
                  <template #icon>
                    <SvgIcon name="List" />
                  </template>
                </n-button>
              </n-dropdown>
            </n-flex>
            <n-flex class="right">
              <!-- 模糊搜索 -->
              <n-input
                v-if="playlistData?.length"
                v-model:value="searchValue"
                :input-props="{ autocomplete: 'off' }"
                class="search"
                :placeholder="t('search.fuzzy_search')"
                clearable
                round
                @input="listSearch"
              >
                <template #prefix>
                  <SvgIcon name="Search" />
                </template>
              </n-input>
            </n-flex>
          </n-flex>
        </div>
      </div>
      <div v-else class="detail">
        <n-skeleton class="cover" />
        <div class="data">
          <n-skeleton :repeat="4" text />
        </div>
      </div>
    </Transition>
    <Transition name="fade" mode="out-in">
      <SongList
        v-if="!searchValue || searchData?.length"
        :data="playlistDataShow"
        :loading="songLoading"
        :height="songListHeight"
        :disabled-sort="songHasMore"
        load-more
        :playlist="{
          id: playlistId,
          platform: '',
          type: 'user-playlist',
        }"
        @scroll="listScroll"
        @remove-song="removeSong"
        :double-click-action="searchData?.length ? 'add' : 'all'"
        @reach-bottom="reachBottom"
        :keep-offset="isSamePlaylist"
      />
      <n-empty
        v-else
        :description="t('search.no_song_result', { keyword: searchValue })"
        style="margin-top: 60px"
        size="large"
      >
        <template #icon>
          <SvgIcon name="SearchOff" />
        </template>
      </n-empty>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import type { DropdownOption, MessageReactive } from "naive-ui";

import { coverLoaded, fuzzySearch, renderIcon } from "@/utils/helper";
import { renderToolbar } from "@/utils/meta";
import { updateUserCreatedPlaylist } from "@/utils/auth";
import { debounce } from "lodash-es";
import { useDataStore, useStatusStore } from "@/stores";
import { openBatchList, openDescModal, openUpdatePlaylist } from "@/utils/modal";
import { usePlayer } from "@/utils/player";
import type { SongInfo, UserPlaylistInfo } from "@/types/main.hemusic";
import { computed } from "vue";
import SongList from "@/components/List/SongList.vue";
import {
  deleteUserPlaylist,
  getUserPlaylistDetail,
  listUserPlaylistSongs,
} from "@/api/userplaylist";
import { formatTimestamp } from "@/utils/time";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const player = usePlayer();
const router = useRouter();
const statusStore = useStatusStore();
const dataStore = useDataStore();

// 歌单数据
const playlistData = shallowRef<SongInfo[]>([]);
const playlistDetailData = ref<UserPlaylistInfo | null>(null);

// 模糊搜索数据
const searchValue = ref<string>("");
const searchData = ref<SongInfo[]>([]);

// 歌单 ID
const oldPlaylistId = ref<string>("");
const playlistId = computed<string>(() => router.currentRoute.value.query.id as string);

// 加载提示
const loading = ref<boolean>(true);
const loadingMsg = ref<MessageReactive | null>(null);

// 搜索数据
const songHasMore = ref<boolean>(false);
const songLoading = ref<boolean>(false);
const songPageIndex = ref<number>(1);

// 列表是否滚动
const listScrolling = ref<boolean>(false);

// 列表应该展示数据
const playlistDataShow = computed(() =>
  searchValue.value ? searchData.value : playlistData.value,
);

// 列表高度
const songListHeight = computed(() => {
  return statusStore.mainContentHeight - (listScrolling.value ? 120 : 240);
});

// 是否为相同歌单
const isSamePlaylist = computed<boolean>(() => oldPlaylistId.value === playlistId.value);

// 更多操作
const moreOptions = computed<DropdownOption[]>(() => [
  {
    label: t("common.delete_playlist"),
    key: "delete",
    show: playlistDetailData.value?.is_default !== 1,
    props: {
      onClick: () => toDeletePlaylist(),
    },
    icon: renderIcon("Delete"),
  },
  {
    label: t("common.batch_operation"),
    key: "batch",
    props: {
      onClick: () => openBatchList(playlistDataShow.value, false, playlistId.value),
    },
    icon: renderIcon("Batch"),
  },
]);

// 获取歌单基础信息
const getPlaylistDetail = async (id: string, refresh: boolean = false) => {
  if (!id) return;
  // 设置加载状态
  loading.value = true;
  songLoading.value = true;
  // 清空数据
  clearInput();
  if (!refresh) resetPlaylistData();
  // 判断是否为本地歌单，本地歌单 ID 为 16 位
  const isLocal = id.toString().length === 16;
  // 本地歌单
  if (isLocal) handleLocalPlaylist(id);
  // 在线歌单
  else await handleOnlinePlaylist(id);
};

// 重置歌单数据
const resetPlaylistData = () => {
  playlistDetailData.value = null;
  playlistData.value = [];
  listScrolling.value = false;
  songPageIndex.value = 1;
};

// 获取本地歌单
const handleLocalPlaylist = (id: string) => {
  console.log(id);
};

// 获取在线歌单
const handleOnlinePlaylist = async (id: string) => {
  // 获取歌单详情
  const detail = await getUserPlaylistDetail(id);
  playlistDetailData.value = detail;
  loading.value = false;
  // 默认歌单
  if (detail.is_default === 1) {
    await dataStore.setUserLikeData("songs", detail.song_ids);
  }
  await handleSongs(id);
};

// 获取在线歌单
const handleSongs = async (id: string) => {
  songLoading.value = true;
  // 获取歌单详情
  const { list, has_more } = await listUserPlaylistSongs(id, songPageIndex.value, 1000);
  if (songPageIndex.value == 1) {
    playlistData.value = [];
  }
  playlistData.value = playlistData.value?.concat(list);
  songHasMore.value = has_more;
  loading.value = false;
  songLoading.value = false;
};

// 列表滚动
const listScroll = (e: Event) => {
  // 滚动高度
  const scrollTop = (e.target as HTMLElement).scrollTop;
  listScrolling.value = scrollTop > 10;
};

// 清除输入
const clearInput = () => {
  searchValue.value = "";
  searchData.value = [];
};

// 加载提示
const loadingMsgShow = (show: boolean = true, count?: number) => {
  if (show) {
    if (count && count <= 800) return;
    loadingMsg.value?.destroy();
    loadingMsg.value = window.$message.loading(t("message.playlist_too_many_songs"), {
      duration: 0,
      closable: true,
    });
  } else {
    loading.value = false;
    loadingMsg.value?.destroy();
    loadingMsg.value = null;
  }
};

// 播放全部歌曲
const playAllSongs = debounce(async () => {
  await loadAllSongs();
  if (!playlistDetailData.value || !playlistData.value?.length) return;
  await player.updatePlayList(playlistData.value, undefined, {
    id: playlistDetailData.value?.id,
    platform: "",
    type: "user-playlist",
  });
}, 300);

const loadAllSongs = async () => {
  for (; songHasMore.value; ) {
    await reachBottom();
  }
};

// 列表触底
const reachBottom = async () => {
  if (songHasMore.value) {
    songPageIndex.value++;
    await handleSongs(playlistId.value);
  } else {
    songLoading.value = false;
  }
};

// 模糊搜索
const listSearch = debounce((val: string) => {
  val = val.trim();
  if (!val || val === "") return;
  // 获取搜索结果

  searchData.value = fuzzySearch(val, playlistData.value);
}, 300);

// 删除歌单
const toDeletePlaylist = async () => {
  if (!playlistDetailData.value || !playlistId.value) return;
  window.$dialog.warning({
    title: t("common.delete_playlist"),
    content: t("message.delete_playlist_confirm"),
    positiveText: t("common.ok"),
    negativeText: t("common.cancel"),
    onPositiveClick: async () => {
      await deleteUserPlaylist(playlistId.value);
      window.$message.success(t("message.delete_playlist_success"));
      await updateUserCreatedPlaylist();
    },
  });
};

// 删除指定索引歌曲
const removeSong = (ids: SongInfo[]) => {
  if (!playlistData.value) return;
  playlistData.value = playlistData.value.filter(
    (song) => !ids.some(({ id, platform }) => song.id === id && song.platform === platform),
  );
  if (playlistDetailData.value) {
    playlistDetailData.value.song_count = playlistData.value?.length?.toString();
  }
  if (playlistDetailData.value?.is_default === 1) {
    dataStore.setUserLikeData(
      "songs",
      playlistData.value.map((item) => ({ id: item.id, platform: item.platform })),
    );
  }
};

// 编辑歌单
const updatePlaylist = () => {
  if (!playlistDetailData.value || !playlistId.value) return;
  openUpdatePlaylist(playlistId.value, playlistDetailData.value, () =>
    getPlaylistDetail(playlistId.value, false),
  );
};

onBeforeRouteUpdate((to) => {
  const id = to.query.id as string;
  if (id) {
    oldPlaylistId.value = id;
    getPlaylistDetail(id);
  }
});

onActivated(() => {
  // 是否为首次进入
  if (!oldPlaylistId.value) {
    oldPlaylistId.value = playlistId.value;
  } else {
    // 是否不相同
    const isSame = oldPlaylistId.value === playlistId.value;
    oldPlaylistId.value = playlistId.value;
    // 刷新歌单
    getPlaylistDetail(playlistId.value, isSame);
  }
});

onDeactivated(() => loadingMsgShow(false));
onUnmounted(() => loadingMsgShow(false));
onMounted(() => getPlaylistDetail(playlistId.value));
</script>

<style lang="scss" scoped>
.playlist {
  display: flex;
  flex-direction: column;
  .detail {
    position: absolute;
    display: flex;
    height: 240px;
    width: 100%;
    padding: 12px 0 30px 0;
    will-change: height, opacity;
    z-index: 1;
    transition:
      height 0.3s,
      opacity 0.3s;
    .cover {
      position: relative;
      display: flex;
      width: auto;
      height: 100%;
      aspect-ratio: 1/1;
      margin-right: 20px;
      border-radius: 8px;
      transition:
        opacity 0.3s,
        margin 0.3s,
        transform 0.3s;
      :deep(img) {
        width: 100%;
        height: 100%;
        opacity: 0;
        transition: opacity 0.35s ease-in-out;
      }
      .cover-img {
        border-radius: 8px;
        overflow: hidden;
        z-index: 1;
        transition:
          opacity 0.3s,
          filter 0.3s,
          transform 0.3s;
      }
      .cover-shadow {
        position: absolute;
        top: 6px;
        height: 100%;
        width: 100%;
        filter: blur(12px) opacity(0.6);
        transform: scale(0.92, 0.96);
        z-index: 0;
        background-size: cover;
        aspect-ratio: 1/1;
        :deep(img) {
          opacity: 1;
        }
      }
      .cover-mask {
        position: absolute;
        top: 0;
        left: 0;
        height: 30%;
        width: 100%;
        border-radius: 8px;
        overflow: hidden;
        z-index: 1;
        background: linear-gradient(rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0));
        transition: opacity 0.3s;
      }
      .play-count {
        position: absolute;
        display: flex;
        align-items: center;
        top: 10px;
        right: 12px;
        color: #fff;
        font-weight: bold;
        z-index: 2;
        transition: opacity 0.3s;
        .n-icon {
          color: #fff;
          font-size: 16px;
          margin-right: 4px;
        }
      }
      &:active {
        transform: scale(0.98);
      }
    }
    .data {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1;
      padding-right: 60px;
      :deep(.n-skeleton) {
        margin-bottom: 12px;
        border-radius: 8px;
        height: 32px;
      }
      :deep(.n-ellipsis) {
        margin-bottom: 8px;
        cursor: pointer;
      }
      .name {
        font-size: 30px;
        font-weight: bold;
        margin-bottom: 12px;
        transition:
          font-size 0.3s var(--n-bezier),
          color 0.3s var(--n-bezier);
        .n-icon {
          cursor: pointer;
          transform: translateY(2px);
        }
      }
      .collapse {
        position: absolute;
        left: 0;
        top: 60px;
        margin-bottom: 12px;
      }
      .meta {
        .item {
          display: flex;
          align-items: center;
          .n-icon {
            font-size: 20px;
            margin-right: 4px;
          }
          .tags {
            margin-left: 4px;
            .n-tag {
              font-size: 13px;
              line-height: 0;
              cursor: pointer;
              transition:
                transform 0.3s,
                background-color 0.3s,
                color 0.3s;
              &:hover {
                background-color: rgba(var(--primary), 0.14);
              }
              &:active {
                transform: scale(0.95);
              }
            }
          }
        }
      }
      .menu {
        position: absolute;
        left: 0;
        bottom: 0;
        width: 100%;
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
    }
  }
  .song-list,
  .loading,
  .n-empty {
    padding-top: 240px;
    transition:
      padding 0.3s,
      opacity 0.3s;
  }
  &.small {
    .detail {
      height: 120px;
      .cover {
        margin-right: 12px;
        .cover-mask,
        .play-count {
          opacity: 0;
        }
      }
      .data {
        .name {
          font-size: 22px;
        }
        .menu {
          .n-button,
          .search {
            height: 32px;
            --n-font-size: 13px;
            --n-padding: 0 14px;
            --n-icon-size: 16px;
          }
        }
      }
    }
    .song-list,
    .loading,
    .n-empty {
      padding-top: 120px;
    }
  }
}
</style>
