<!-- 播放列表 -->
<template>
  <n-drawer
    id="main-playlist"
    v-model:show="statusStore.playListShow"
    :class="{ 'full-player': statusStore.showFullPlayer }"
    :style="{
      'max-width': isSmallScreen ? '100%' : '400px',
    }"
    :auto-focus="false"
    style="width: 400px"
  >
    <n-drawer-content :native-scrollbar="false" closable>
      <template #header>
        <div class="playlist-header">
          <n-text class="name">
            {{ t("common.play_queue") }}
          </n-text>
          <n-text class="count" depth="3">
            {{ t("common.song_count", { count: dataStore.playList.length }) }}
          </n-text>
        </div>
      </template>
      <Transition name="fade" mode="out-in">
        <!-- 播放列表 -->
        <div v-if="playListData.length" class="queue-body">
          <n-input
            v-model:value="searchQuery"
            class="queue-search"
            :placeholder="t('play_queue.search')"
            :input-props="{ 'aria-label': t('play_queue.search') }"
            clearable
          />
          <div
            ref="queueViewport"
            class="queue-viewport"
            :class="{ sorting: lifted }"
            :style="{ '--queue-row-height': rowHeight + 'px' }"
          >
            <n-virtual-list
              ref="playListRef"
              :item-size="rowHeight"
              :items="visibleQueueSongs"
              :default-scroll-index="statusStore.playIndex"
              class="playlist-list"
            >
              <template #default="{ item: songData, index }">
                <div v-if="isSearching" class="queue-slot">
                  <button
                    type="button"
                    class="song-item search-result"
                    :class="{ on: statusStore.playIndex === songData.queueIndex }"
                    :aria-description="t('play_queue.locate_result')"
                    @click="revealSearchResult(songData)"
                  >
                    <QueueSongDetails
                      :song="songData"
                      :position="songData.queueIndex + 1"
                      :playing="statusStore.playIndex === songData.queueIndex"
                    />
                  </button>
                </div>
                <div v-else class="queue-slot" :data-queue-index="index" :class="slotClass(index)">
                  <div
                    v-debounce="() => playItem(index)"
                    :ref="locatedKey === songData.key ? focusLocatedItem : undefined"
                    class="song-item"
                    :class="{
                      on: statusStore.playIndex === index,
                      located: locatedKey === songData.key,
                    }"
                    tabindex="-1"
                  >
                    <QueueSongDetails
                      :song="songData"
                      :position="index + 1"
                      :playing="statusStore.playIndex === index"
                    />
                    <button
                      v-if="playListData.length > 1"
                      type="button"
                      class="reorder"
                      :aria-label="t('play_queue.reorder', { name: songData.name })"
                      :aria-description="t('play_queue.keyboard')"
                      aria-keyshortcuts="ArrowUp ArrowDown"
                      @click.stop
                      @pointerdown.stop="startDrag($event, index)"
                      @keydown.up.prevent.stop="moveItem(index, index - 1)"
                      @keydown.down.prevent.stop="moveItem(index, index + 1)"
                    >
                      <SvgIcon :size="20" name="GripVertical" />
                    </button>
                    <div class="remove" @click.stop="player.removeSongIndex(index)">
                      <SvgIcon :size="20" name="Delete" />
                    </div>
                  </div>
                </div>
              </template>
            </n-virtual-list>
            <div v-if="isSearching && !visibleQueueSongs.length" class="search-empty" role="status">
              <n-empty :description="t('play_queue.search_empty')" />
            </div>
            <div
              v-if="lifted"
              ref="previewRow"
              class="song-item lifted-row"
              :class="{ on: statusStore.playIndex === lifted.from }"
              :style="{
                left: lifted.left + 'px',
                width: lifted.width + 'px',
                '--queue-lift-origin': lifted.top + 'px',
              }"
              aria-hidden="true"
            >
              <QueueSongDetails
                :song="lifted.song"
                :position="(dropIndex ?? lifted.from) + 1"
                :playing="statusStore.playIndex === lifted.from"
              />
              <span class="reorder"><SvgIcon :size="20" name="GripVertical" /></span>
              <span class="remove"><SvgIcon :size="20" name="Delete" /></span>
            </div>
          </div>
        </div>
        <n-empty
          v-else
          :description="t('play.no_songs')"
          class="tip"
          size="large"
          style="margin-top: 60px"
        />
      </Transition>
      <span class="queue-announcement" role="status">{{ announcement }}</span>
      <template #footer>
        <n-grid :cols="2" x-gap="16" class="playlist-menu">
          <n-gi>
            <n-button :focusable="false" size="large" strong secondary @click="cleanPlayList">
              <template #icon>
                <SvgIcon name="DeleteSweep" />
              </template>
              {{ t("common.clear_list") }}
            </n-button>
          </n-gi>
          <n-gi>
            <n-button :focusable="false" size="large" strong secondary @click="revealCurrentSong">
              <template #icon>
                <SvgIcon name="Location" />
              </template>
              {{ t("common.current_play") }}
            </n-button>
          </n-gi>
        </n-grid>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { useStatusStore, useDataStore } from "@/stores";
import { NVirtualList } from "naive-ui";
import type { ComponentPublicInstance } from "vue";
import { usePlayer } from "@/utils/player";
import { useI18n } from "vue-i18n";
import { useMobile } from "@/composables/useMobile";
import { useOverlayBack } from "@/composables/useOverlayBack";
import type { SongInfo } from "@/types/main.hemusic";
import QueueSongDetails from "./QueueSongDetails.vue";
import { filterQueueSongs, normalizeQueueSearch } from "./queueSearch";
const { t } = useI18n();
const player = usePlayer();
const dataStore = useDataStore();
const statusStore = useStatusStore();
const { isSmallScreen } = useMobile();
useOverlayBack(
  () => statusStore.playListShow,
  () => {
    statusStore.playListShow = false;
  },
);

const playListRef = ref<InstanceType<typeof NVirtualList> | null>(null);
const queueViewport = ref<HTMLDivElement | null>(null);
const previewRow = ref<HTMLDivElement | null>(null);
const rowHeight = 80;
const announcement = ref("");
const searchQuery = ref("");
const normalizedQuery = computed(() => normalizeQueueSearch(searchQuery.value));
const isSearching = computed(() => Boolean(normalizedQuery.value));
const locatedKey = ref<string>();
let pendingFocus = false;
const dropIndex = ref<number | null>(null);
const lifted = shallowRef<{
  song: SongInfo;
  from: number;
  left: number;
  top: number;
  width: number;
}>();
let drag:
  | {
      id: number;
      from: number;
      revision: symbol;
      scroller: HTMLElement;
      firstRow: number;
      grabOffset: number;
      height: number;
      startY: number;
      y: number;
    }
  | undefined;
let frame = 0;
let settle: Animation | undefined;

// 播放列表数据
const playListData = computed(() => {
  const occurrences = new Map<string, number>();
  return dataStore.playList.map((item, queueIndex) => {
    const identity = JSON.stringify([item.platform, item.id]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { ...item, key: identity + ":" + occurrence, queueIndex };
  });
});
const visibleQueueSongs = computed(() =>
  filterQueueSongs(playListData.value, normalizedQuery.value),
);

async function revealSearchResult(song: (typeof playListData.value)[number]) {
  if (playListData.value[song.queueIndex] !== song) return;
  const revision = dataStore.playbackRevision;
  searchQuery.value = "";
  await nextTick();
  if (!statusStore.playListShow || isSearching.value || revision !== dataStore.playbackRevision)
    return;
  pendingFocus = true;
  locatedKey.value = song.key;
  announcement.value = t("play_queue.located", { position: song.queueIndex + 1 });
  scrollToItem(song.queueIndex, "auto");
}

function focusLocatedItem(row: Element | ComponentPublicInstance | null) {
  if (!pendingFocus || !(row instanceof HTMLElement)) return;
  // 远端曲目只有进入虚拟列表视口后才有对应元素。
  void nextTick(() => {
    if (!pendingFocus || !row.isConnected || !statusStore.playListShow || isSearching.value) return;
    pendingFocus = false;
    row.focus({ preventScroll: true });
  });
}

async function revealCurrentSong() {
  if (isSearching.value) {
    searchQuery.value = "";
    await nextTick();
  }
  locatedKey.value = undefined;
  pendingFocus = false;
  scrollToItem(statusStore.playIndex);
}

async function moveItem(from: number, to: number, revision = dataStore.playbackRevision) {
  try {
    if (await player.moveQueueItem(from, to, revision)) {
      announcement.value = t("play_queue.position", { position: to + 1 });
    }
  } catch {
    window.$message.error(t("play_queue.save_failed"));
  }
}

function playItem(index: number) {
  if (drag) return;
  void player.togglePlayIndex(index, true);
  statusStore.playListShow = false;
}

function slotClass(index: number) {
  const from = lifted.value?.from;
  const to = dropIndex.value;
  if (from === undefined || to === null) return;
  if (index === from) return "vacant";
  if (from < index && index <= to) return "shift-up";
  if (to <= index && index < from) return "shift-down";
  return undefined;
}

function startDrag(event: PointerEvent, from: number) {
  if (
    drag ||
    isSearching.value ||
    !event.isPrimary ||
    event.button !== 0 ||
    !(event.currentTarget instanceof HTMLElement) ||
    !queueViewport.value
  )
    return;
  const handle = event.currentTarget;
  const row = handle.closest(".song-item");
  const slot = handle.closest(".queue-slot");
  const scroller = playListRef.value?.getScrollContainer();
  if (!row || !slot || !scroller) return;
  const rect = row.getBoundingClientRect();
  const firstRow =
    slot.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop -
    from * rowHeight;
  drag = {
    id: event.pointerId,
    from,
    revision: dataStore.playbackRevision,
    scroller,
    firstRow,
    grabOffset: event.clientY - rect.top,
    height: rect.height,
    startY: event.clientY,
    y: event.clientY,
  };
  scroller.addEventListener("pointermove", moveDrag);
  scroller.addEventListener("pointerup", dropDrag);
  scroller.addEventListener("pointercancel", cancelDrag);
  scroller.addEventListener("lostpointercapture", cancelDrag);
  scroller.setPointerCapture(event.pointerId);
}

function targetIndex(y: number, activeDrag: NonNullable<typeof drag>, scrollerTop: number) {
  const { scroller, grabOffset, firstRow } = activeDrag;
  const offset = y - grabOffset - scrollerTop + scroller.scrollTop;
  return Math.max(
    0,
    Math.min(playListData.value.length - 1, Math.round((offset - firstRow) / rowHeight)),
  );
}

function updateDrop() {
  frame = 0;
  if (!drag || !lifted.value || !queueViewport.value) return;
  const { scroller, y, grabOffset, height } = drag;
  const { top, bottom } = scroller.getBoundingClientRect();
  const viewport = queueViewport.value.getBoundingClientRect();
  const scroll = y < top + 32 ? -8 : y > bottom - 32 ? 8 : 0;
  const previous = scroller.scrollTop;
  if (scroll) scroller.scrollTop += scroll;
  dropIndex.value = targetIndex(y, drag, top);
  const previewY = Math.max(0, Math.min(viewport.height - height, y - grabOffset - viewport.top));
  // 像素级位移写入浮层，不让整列跟随每一帧重新渲染。
  if (previewRow.value) previewRow.value.style.transform = "translateY(" + previewY + "px)";
  if (scroller.scrollTop !== previous) frame = requestAnimationFrame(updateDrop);
}

function moveDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id || !queueViewport.value) return;
  drag.y = event.clientY;
  if (!lifted.value) {
    if (Math.abs(drag.y - drag.startY) < 6) return;
    const row = drag.scroller.querySelector('[data-queue-index="' + drag.from + '"] .song-item');
    const song = playListData.value[drag.from];
    if (!row || !song) {
      cancelDrag();
      return;
    }
    const rect = row.getBoundingClientRect();
    const viewport = queueViewport.value.getBoundingClientRect();
    lifted.value = {
      song,
      from: drag.from,
      left: rect.left - viewport.left,
      top: drag.y - drag.grabOffset - viewport.top,
      width: rect.width,
    };
    dropIndex.value = drag.from;
    settle?.cancel();
    settle = undefined;
  }
  if (!frame) frame = requestAnimationFrame(updateDrop);
}

function cancelDrag(event?: PointerEvent) {
  if (!drag || (event && event.pointerId !== drag.id)) return;
  const { id, scroller } = drag;
  drag = undefined;
  scroller.removeEventListener("pointermove", moveDrag);
  scroller.removeEventListener("pointerup", dropDrag);
  scroller.removeEventListener("pointercancel", cancelDrag);
  scroller.removeEventListener("lostpointercapture", cancelDrag);
  if (scroller.hasPointerCapture(id)) scroller.releasePointerCapture(id);
  cancelAnimationFrame(frame);
  frame = 0;
  lifted.value = undefined;
  dropIndex.value = null;
}

function dropDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return;
  const { from, revision, scroller } = drag;
  const to = lifted.value
    ? targetIndex(event.clientY, drag, scroller.getBoundingClientRect().top)
    : null;
  const previewTop = previewRow.value?.getBoundingClientRect().top;
  cancelDrag();
  if (to === null || revision !== dataStore.playbackRevision) return;
  void moveItem(from, to, revision);
  const committedRevision = dataStore.playbackRevision;
  if (previewTop === undefined || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    return;
  void nextTick(() => {
    if (drag || isSearching.value || dataStore.playbackRevision !== committedRevision) return;
    const row = scroller.querySelector('[data-queue-index="' + to + '"] .song-item');
    if (!row) return;
    const delta = previewTop - row.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) return;
    settle = row.animate([{ transform: "translateY(" + delta + "px)" }, { transform: "none" }], {
      duration: 160,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
  });
}

watch(
  () => dataStore.playbackRevision,
  () => {
    cancelDrag();
    locatedKey.value = undefined;
    pendingFocus = false;
  },
);
watch(normalizedQuery, (query) => {
  cancelDrag();
  settle?.cancel();
  settle = undefined;
  locatedKey.value = undefined;
  pendingFocus = false;
  if (query) {
    announcement.value = "";
    void nextTick(() => playListRef.value?.scrollTo({ position: "top", behavior: "auto" }));
  }
});
watch(
  () => playListData.value.length,
  (length) => {
    if (!length) searchQuery.value = "";
  },
);
watch(
  () => statusStore.playListShow,
  (shown) => {
    if (shown) return;
    cancelDrag();
    searchQuery.value = "";
    locatedKey.value = undefined;
    pendingFocus = false;
    announcement.value = "";
  },
);
onBeforeUnmount(() => {
  cancelDrag();
  settle?.cancel();
});

// 滚动至指定元素
const scrollToItem = (index: number, behavior: "smooth" | "auto" = "smooth") => {
  if (index < 0 || index >= playListData.value.length) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  playListRef.value?.scrollTo({ index, behavior: reduceMotion ? "auto" : behavior });
};

// 清空播放列表
const cleanPlayList = () => {
  window.$dialog.warning({
    title: t("common.clear_list"),
    content: t("common.clear_play_list_confirm"),
    positiveText: t("common.ok"),
    negativeText: t("common.cancel"),
    onPositiveClick: () => {
      player.cleanPlayList();
      window.$message.success(t("message.play_list_cleared"));
    },
  });
};
</script>

<style lang="scss" scoped>
.playlist-header {
  display: flex;
  flex-direction: column;
  .count {
    margin-top: 8px;
    font-size: 12px;
  }
}
.queue-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: calc(100dvh - 142px);
}
.queue-search {
  flex: none;
  width: auto;
  margin: 12px 16px 0;
}
.queue-viewport {
  position: relative;
  isolation: isolate;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.search-empty {
  position: absolute;
  inset: 32px 16px auto;
}
.playlist-list {
  height: 100%;
  padding: 16px;
}
.queue-slot {
  height: var(--queue-row-height);
}
.song-item {
  display: flex;
  align-items: center;
  height: 64px;
  overflow: hidden;
  border-radius: 8px;
  padding: 0 12px;
  border: 1px solid transparent;
  background-color: rgba(var(--primary), 0.08);
  cursor: pointer;

  &.on {
    background-color: rgba(var(--primary), 0.29);
  }
  &.on,
  &.located,
  &:focus-visible,
  &:hover {
    border-color: var(--primary-hex);
  }
}
.search-result {
  width: 100%;
  color: inherit;
  font: inherit;
  text-align: start;
}
.remove {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  border-radius: 8px;
  &:hover {
    background-color: rgba(var(--primary), 0.29);
  }
}
.sorting {
  user-select: none;

  .queue-slot .song-item {
    transition: transform 160ms cubic-bezier(0.2, 0.8, 0.25, 1);
  }
  .vacant .song-item {
    opacity: 0;
  }
  .shift-up .song-item {
    transform: translateY(calc(0px - var(--queue-row-height)));
  }
  .shift-down .song-item {
    transform: translateY(var(--queue-row-height));
  }
}
.song-item.lifted-row {
  position: absolute;
  z-index: 1;
  top: 0;
  pointer-events: none;
  transform: translateY(var(--queue-lift-origin));
  background-color: rgb(var(--background));
  background-color: color-mix(in srgb, rgb(var(--background)) 92%, var(--primary-hex));
  border-color: rgba(var(--primary), 0.6);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  will-change: transform;

  .reorder {
    background: rgba(var(--primary), 0.16);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sorting .queue-slot .song-item {
    transition: none;
  }
}
.reorder {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: inherit;
  background: transparent;
  cursor: grab;
  touch-action: none;
  &:active {
    cursor: grabbing;
    background: rgba(var(--primary), 0.16);
  }
}
.queue-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.playlist-menu {
  height: 40px;
  .n-button {
    width: 100%;
    border-radius: 8px;
  }
}
</style>

<style lang="scss">
#main-playlist {
  --n-border-radius: 12px;
  .n-drawer-header {
    height: 70px;
  }
  .n-scrollbar-content {
    padding: 0;
    height: 100%;
  }
  .n-drawer-footer {
    height: 72px;
    padding: 16px;
  }
  &.full-player {
    --n-color: rgb(var(--main-cover-color));
    --n-close-icon-color: rgba(var(--main-cover-color), 0.58);
    background-color: transparent;
    box-shadow: none;
    .n-drawer-header,
    .n-drawer-footer {
      border: none;
    }
    a,
    span,
    .n-icon {
      color: rgb(var(--main-cover-color));
    }
    .lifted-row {
      background-color: Canvas;
      background-color: color-mix(in srgb, Canvas 94%, var(--primary-hex));
      span,
      .n-icon {
        color: CanvasText;
      }
    }
    .n-button {
      --n-color: rgba(var(--main-cover-color), 0.08);
      --n-color-hover: rgba(var(--main-cover-color), 0.12);
      --n-color-pressed: var(--n-color);
      --n-color-focus: var(--n-color-hover);
    }
    .playlist-list {
      .song-item {
        background-color: rgba(var(--main-cover-color), 0.08);
        &.on,
        &.located,
        &:focus-visible,
        &:hover {
          border-color: rgb(var(--main-cover-color));
        }
        .num {
          color: rgba(var(--main-cover-color), 0.52);
        }
      }
    }
  }
}
</style>
