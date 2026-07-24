<!-- 歌曲列表 - 虚拟列表 -->
<template>
  <Transition name="fade" mode="out-in">
    <div v-if="!isEmpty(listData)" ref="songListRef" class="song-list">
      <Transition name="fade" mode="out-in">
        <div
          :key="listKey"
          :style="{
            height: height === 'auto' ? 'auto' : `${height || songListHeight}px`,
            transition: disableHeightTransition ? 'transform 0.3s, opacity 0.3s' : undefined,
          }"
          class="virtual-list-wrapper"
        >
          <!-- 悬浮顶栏 -->
          <div v-if="showHeader" class="list-header song-card sticky-header">
            <n-text class="num">#</n-text>
            <n-popover
              v-if="!disabledSort"
              trigger="click"
              placement="bottom-start"
              :show-arrow="false"
              style="padding: 0"
            >
              <template #trigger>
                <div class="title has-sort">
                  <n-text> {{ t("common.title") }}</n-text>
                  <n-text v-if="statusStore.listSortField !== 'default'" class="sort" depth="3">
                    {{ t(`sort.field.${statusStore.listSortField}`) }}
                  </n-text>
                </div>
              </template>
              <div class="sort-menu">
                <div class="group">
                  <div class="label">排序字段</div>
                  <n-radio-group
                    v-model:value="statusStore.listSortField"
                    name="sortField"
                    @update:value="(val) => handleSortFieldChange(val)"
                  >
                    <n-flex :vertical="true" size="small">
                      <n-radio v-for="(_, key) in sortFieldOptions" :key="key" :value="key">
                        {{ t(`sort.field.${key}`) }}
                      </n-radio>
                    </n-flex>
                  </n-radio-group>
                </div>
                <n-divider vertical style="height: auto; margin: 0 12px" />
                <div class="group">
                  <div class="label">排序方式</div>
                  <n-radio-group
                    v-model:value="statusStore.listSortOrder"
                    name="sortOrder"
                    @update:value="(val) => handleSortOrderChange(val)"
                  >
                    <n-flex :vertical="true" size="small">
                      <n-radio v-for="(_, key) in sortOrderOptions" :key="key" :value="key">
                        {{ t(`sort.order.${key}`) }}
                      </n-radio>
                    </n-flex>
                  </n-radio-group>
                </div>
              </div>
            </n-popover>
            <n-text v-else class="title"> {{ t("common.title") }}</n-text>
            <n-text v-if="!hiddenAlbum && !isSmallScreen" class="album">
              {{ t("common.album") }}
            </n-text>
            <n-text class="actions">
              {{ t("common.operation") }}
            </n-text>
            <n-text v-if="!isSmallScreen" class="meta">
              {{ t("common.duration") }}
            </n-text>
            <n-text v-if="!hiddenSize && !isSmallScreen" class="meta size">
              {{ t("common.size") }}
            </n-text>
          </div>
          <!-- 虚拟列表 -->
          <VirtualScroll
            ref="listRef"
            :item-height="90"
            :item-fixed="false"
            :items="virtualListItems"
            :height="showHeader ? 'calc(100% - 40px)' : '100%'"
            :padding-bottom="showFooter ? 80 : 0"
            @scroll="onScroll"
          >
            <template #default="{ item, index }">
              <SongCard
                v-if="item.type === 'song'"
                :song="item.data"
                :index="index"
                :hiddenCover="hiddenCover"
                :hiddenAlbum="hiddenAlbum"
                :hiddenSize="hiddenSize"
                :highlight-keywords="highlightKeywords?.[index]"
                @click="handleSongClick(item.data)"
                @dblclick.stop="handleSongDoubleClick(item.data)"
                @contextmenu.stop="handleShowMenu($event, item.data, index)"
                @show-menu="handleShowMenu($event, item.data, index)"
              >
                <template #tags>
                  <slot name="tags" :song="item.data" :index="index" />
                </template>
                <template #details>
                  <slot name="details" :song="item.data" :index="index" />
                </template>
              </SongCard>
              <slot
                v-if="item.type === 'song'"
                name="item-after"
                :song="item.data"
                :index="index"
              />
              <!-- 加载更多 -->
              <div v-else-if="item.type === 'footer'" class="load-more">
                <n-flex v-if="loadMore && loading">
                  <n-spin size="small" />
                  <n-text>{{ loadingText || t("common.effort_loading") }}</n-text>
                </n-flex>
                <n-divider v-else dashed> {{ t("common.no_more_data") }} </n-divider>
              </div>
            </template>
          </VirtualScroll>
        </div>
      </Transition>
      <!-- 右键菜单 -->
      <SongListMenu ref="songListMenuRef" @removeSong="removeSong" />
      <MobileSongMenu ref="mobileSongMenuRef" @removeSong="removeSong" />
      <!-- 列表操作 -->
      <Teleport to="body">
        <Transition name="fade" mode="out-in">
          <n-float-button-group v-if="floatToolShow" class="list-menu">
            <Transition name="fade" mode="out-in">
              <n-float-button v-if="scrollTop > 100" width="42" @click="scrollToTop">
                <SvgIcon :size="22" name="Up" />
              </n-float-button>
            </Transition>
            <n-float-button v-if="hasPlaySong >= 0" width="42" @click="scrollToCurrentSong">
              <SvgIcon :size="22" name="Location" />
            </n-float-button>
          </n-float-button-group>
        </Transition>
      </Teleport>
    </div>
    <!-- 列表加载 - 骨架屏 -->
    <div v-else-if="loading" class="song-list loading">
      <n-skeleton :repeat="10" text />
    </div>
    <!-- 空列表 -->
    <n-empty v-else :description="t('common.list_empty')" size="large" class="song-list empty" />
  </Transition>
</template>

<script setup lang="ts">
import type { SortField, SortOrder } from "@/types/main";
import { useMusicStore, useStatusStore } from "@/stores";
import { isEmpty } from "lodash-es";
import { sortFieldOptions, sortOrderOptions } from "@/utils/meta";
import { useMobile } from "@/composables/useMobile";
import SongListMenu from "@/components/Menu/SongListMenu.vue";
import MobileSongMenu from "@/components/Menu/MobileSongMenu.vue";
import VirtualScroll from "@/components/UI/VirtualScroll.vue";
import type { SongInfo } from "@/types/main.hemusic";
import { usePlayer } from "@/utils/player";
import { useI18n } from "vue-i18n";
const props = withDefaults(
  defineProps<{
    /** 列表数据 */
    data: SongInfo[];
    /** 列表类型 */
    type?: "song";
    /** 列表高度 */
    height?: number | "auto";
    /** 是否加载 */
    loading?: boolean;
    /** 加载更多 */
    loadMore?: boolean;
    /** 加载文本 */
    loadingText?: string;
    /** 隐藏专辑 */
    hiddenAlbum?: boolean;
    /** 隐藏封面 */
    hiddenCover?: boolean;
    /** 隐藏大小 */
    hiddenSize?: boolean;
    /** 隐藏滚动条 */
    hiddenScrollbar?: boolean;
    /** 禁用排序 */
    disabledSort?: boolean;
    playlist?: {
      id: string;
      platform?: string;
      type?: string;
    };
    // 显示底部
    showFooter?: boolean;
    showHeader?: boolean;
    // 双击播放操作
    doubleClickAction?: "all" | "add";
    keepOffset?: boolean;
    /** 禁用高度过渡动画 */
    disableHeightTransition?: boolean;
    /** 每首歌曲对应的纯文本高亮词。 */
    highlightKeywords?: string[][];
    /** 单击歌曲卡片时直接播放。 */
    singleClickAction?: boolean;
  }>(),
  {
    type: "song",
    loadingText: "",
    showFooter: true,
    hiddenSize: true,
    showHeader: true,
    keepOffset: true,
  },
);

const emit = defineEmits<{
  // 触底
  reachBottom: [e: Event];
  // 滚动
  scroll: [e: Event];
  // 删除歌曲
  removeSong: [info: SongInfo[]];
}>();

const musicStore = useMusicStore();
const statusStore = useStatusStore();
const { t } = useI18n();
const player = usePlayer();
const { isSmallScreen } = useMobile();

// 处理移动端单击播放
// const handleSongClick = (song: SongInfo) => {
//   if (isSmallScreen.value) {
//     player.addNextSong(song, true);
//   }
// };

// 处理歌曲播放
const handleSongPlay = (song: SongInfo) => {
  if (props.doubleClickAction === "add") {
    player.addNextSong(song, true);
  } else {
    player.updatePlayList(listData.value, song, props.playlist);
  }
};

const handleSongClick = (song: SongInfo) => {
  if (props.singleClickAction) handleSongPlay(song);
};

const handleSongDoubleClick = (song: SongInfo) => {
  if (!props.singleClickAction) handleSongPlay(song);
};

// 列表状态
const scrollTop = ref<number>(0);
const scrollIndex = ref<number>(0);

// 列表元素
const listRef = ref<InstanceType<typeof VirtualScroll> | null>(null);
const songListRef = ref<HTMLElement | null>(null);

// 悬浮工具
const floatToolShow = ref<boolean>(true);

// 右键菜单
const songListMenuRef = ref<InstanceType<typeof SongListMenu> | null>(null);
const mobileSongMenuRef = ref<InstanceType<typeof MobileSongMenu> | null>(null);

const handleShowMenu = (e: MouseEvent, song: SongInfo, index: number) => {
  if (isSmallScreen.value) {
    mobileSongMenuRef.value?.open(song, index, props.playlist);
  } else {
    songListMenuRef.value?.openDropdown(e, listData.value, song, index, props.playlist);
  }
};

// 列表数据
const listData = computed<SongInfo[]>(() => {
  if (props.disabledSort) return props.data;
  // 若未启用排序或默认排序
  if (statusStore.listSortField === "default" || statusStore.listSortOrder === "default") {
    return props.data;
  }

  // 创建副本用于排序
  const data = [...props.data];
  const field = statusStore.listSortField;
  const order = statusStore.listSortOrder;
  const isAsc = order === "asc";

  return data.sort((a, b) => {
    let result = 0;
    switch (field) {
      case "title":
        result = a.name.localeCompare(b.name, "zh-CN");
        break;
      case "artist": {
        const artistA = Array.isArray(a.artists)
          ? a.artists[0]?.name || ""
          : (a.artists as string) || "";
        const artistB = Array.isArray(b.artists)
          ? b.artists[0]?.name || ""
          : (b.artists as string) || "";
        result = artistA.localeCompare(artistB, "zh-CN");
        break;
      }
      case "album": {
        const albumA = typeof a.album === "string" ? a.album : a.album?.name || "";
        const albumB = typeof b.album === "string" ? b.album : b.album?.name || "";
        result = albumA.localeCompare(albumB, "zh-CN");
        break;
      }
      case "duration":
        result = a.duration - b.duration;
        break;
      case "size":
        result = (a.size || 0) - (b.size || 0);
        break;
      default:
        break;
    }
    return isAsc ? result : -result;
  });
});

// 虚拟列表项类型
type VirtualListItem =
  | { type: "song"; data: SongInfo; key: string }
  | { type: "footer"; data: null; key: string };

// 虚拟列表数据（包含歌曲和 footer）
const virtualListItems = computed<VirtualListItem[]>(() => {
  const items: VirtualListItem[] = listData.value.map((song) => ({
    type: "song" as const,
    data: song,
    key: `${song.platform}-${song.id}`,
  }));
  // 如果有加载更多，添加 footer
  if (props.showFooter && props.loadMore !== undefined) {
    items.push({
      type: "footer" as const,
      data: null,
      key: "footer",
    });
  }
  return items;
});

// 虚拟列表 key
const listKey = computed(() => {
  // 使用 playListId 作为主要 key
  if (props.playlist?.id) {
    return `playlist-${props.playlist?.platform}-${props.playlist?.id}-${statusStore.listSortField}-${statusStore.listSortOrder}`;
  }
  return `list-${props.type}-${statusStore.listSortField}-${statusStore.listSortOrder}`;
});

// 列表是否具有播放歌曲
const hasPlaySong = computed(() => {
  return listData.value.findIndex((item) => item.id === musicStore.playSong.id);
});

// 列表元素高度
const { height: songListHeight, stop: stopCalcHeight } = useElementSize(songListRef);

// 列表滚动
const onScroll = (e: Event) => {
  emit("scroll", e);
  const target = e.target as HTMLElement;
  const top = target.scrollTop;
  scrollTop.value = top;
  scrollIndex.value = Math.floor(top / 90);

  // 触底检测
  const scrollHeight = target.scrollHeight;
  const clientHeight = target.clientHeight;
  if (scrollHeight - top - clientHeight < 100 && !props.loading && props.loadMore) {
    emit("reachBottom", e);
  }
};

// 滚动到顶部
const scrollToTop = () => {
  listRef.value?.scrollToIndex(0);
};

// 滚动到当前播放歌曲
const scrollToCurrentSong = () => {
  if (hasPlaySong.value >= 0) {
    listRef.value?.scrollToIndex(hasPlaySong.value);
  }
};

const refreshMeasurements = () => {
  listRef.value?.refreshMeasurements();
};

defineExpose({ refreshMeasurements });

// 更新列表播放顺序
const updatePlayListOrder = () => {
  // 更新列表
  if (
    musicStore.isPlayingPlaylist(
      props.playlist?.id || "",
      props.playlist?.platform || "",
      props.playlist?.type || "",
    )
  ) {
    player.updatePlayList(listData.value, musicStore.playSong, props.playlist, {
      showTip: false,
      play: false,
    });
  }
  // 滚动到当前播放歌曲或顶部
  nextTick(() => {
    if (hasPlaySong.value >= 0) {
      listRef.value?.scrollToIndex(hasPlaySong.value);
    } else {
      listRef.value?.scrollToIndex(0);
    }
  });
};

// 排序更改
const handleSortFieldChange = (val: SortField) => {
  // 单击已选择的字段 -> 切换升降序
  if (statusStore.listSortField === val && val !== "default") {
    statusStore.listSortOrder = statusStore.listSortOrder === "asc" ? "desc" : "asc";
  } else {
    statusStore.listSortField = val;
    // 如果切换到具体的字段且当前顺序是默认，自动切换到降序(对于时间相关)或升序(对于文本)
    if (statusStore.listSortOrder === "default") {
      if (val === "duration") {
        statusStore.listSortOrder = "desc";
      } else {
        statusStore.listSortOrder = "asc";
      }
    }
  }
  updatePlayListOrder();
};

const handleSortOrderChange = (val: SortOrder) => {
  statusStore.listSortOrder = val;
  updatePlayListOrder();
};

// 删除指定索引
const removeSong = (song: SongInfo[]) => emit("removeSong", song);

// keep-alive 处理
onBeforeRouteLeave(() => {
  floatToolShow.value = false;
});

onActivated(() => {
  floatToolShow.value = true;
  if (props.height === "auto") stopCalcHeight();
  if (scrollIndex.value > 0) {
    nextTick(() => {
      listRef.value?.scrollToIndex(scrollIndex.value);
    });
  }
});

onBeforeUnmount(() => {
  stopCalcHeight();
  floatToolShow.value = false;
});
</script>

<style lang="scss" scoped>
.song-list {
  height: 100%;
  border-radius: 12px 0 0 12px;
  overflow: hidden;
  .song-card {
    padding-bottom: 12px;
    // padding-right: 4px;
  }
  // 悬浮顶栏
  .list-header {
    width: 100%;
    height: 40px;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    // margin-right: 4px;
    border: 1px solid transparent;
    // background-color: var(--background-hex);
    .n-text {
      opacity: 0.6;
    }
    .num {
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      width: 40px;
      min-width: 40px;
      font-weight: bold;
      margin-right: 12px;
    }
    .title {
      position: relative;
      flex: 1;
      display: flex;
      align-items: center;
      padding: 4px 20px 4px 0;
      cursor: pointer;
      .sort {
        margin-left: 6px;
        &::after {
          content: " )";
        }
        &::before {
          content: "( ";
        }
      }
      &.has-sort {
        &::after {
          content: "";
          position: absolute;
          opacity: 0;
          top: 0;
          left: -8px;
          width: 100%;
          height: 100%;
          border-radius: 8px;
          background-color: rgba(var(--primary), 0.08);
          transition: opacity 0.3s;
        }
        &:hover {
          &::after {
            opacity: 1;
          }
        }
      }
    }
    .album {
      flex: 1;
      padding-right: 20px;
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
    }
    .meta {
      width: 50px;
      text-align: center;
      &.size {
        width: 60px;
      }
      &.date {
        width: 80px;
      }
    }
  }
  .virtual-list-wrapper {
    height: 100%;
    position: relative;
    transition:
      height 0.3s,
      transform 0.3s,
      opacity 0.3s;
    .sticky-header {
      position: sticky;
      top: 0;
      z-index: 10;
    }
  }
  // 加载更多
  .load-more {
    display: flex;
    flex-direction: row;
    justify-content: center;
    margin: 20px 0 40px;
    .n-spin-body {
      --n-size: 20px;
    }
    .n-divider {
      margin: 0;
      font-size: 14px;
      opacity: 0.6;
    }
  }
  // 加载
  &.loading {
    margin-top: 20px;
    :deep(.n-skeleton) {
      height: 72px;
      margin-bottom: 12px;
      border-radius: 12px;
    }
  }
  // 空列表
  &.empty {
    margin-top: 60px;
  }
}
.list-menu {
  position: fixed;
  right: 40px;
  bottom: 120px;
  .n-float-button {
    height: 42px;
    border: 1px solid rgba(var(--primary), 0.28);
  }
}
.sort-menu {
  display: flex;
  padding: 12px;
  .group {
    display: flex;
    flex-direction: column;
    .label {
      font-size: 12px;
      opacity: 0.6;
      margin-bottom: 8px;
      padding-left: 4px;
    }
    .n-radio-group {
      width: 120px;
      .n-radio {
        --n-font-size: 13px;
        padding: 4px 8px;
        border-radius: 4px;
        transition: background-color 0.3s;
        &:hover {
          background-color: var(--n-color-target);
        }
      }
    }
  }
}
</style>
