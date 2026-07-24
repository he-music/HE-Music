<template>
  <SongList
    ref="songListRef"
    :data="songs"
    :height="height"
    :loading="loading"
    :load-more="loadMore"
    :show-header="showHeader"
    :show-footer="showFooter"
    :highlight-keywords="highlightKeywords"
    :hidden-size="true"
    single-click-action
    double-click-action="add"
    disabled-sort
    @reach-bottom="emit('reachBottom', $event)"
  >
    <template #tags="{ index }">
      <n-tag
        v-if="data[index]?.original_type === 1"
        class="original-tag"
        :bordered="false"
        type="primary"
        round
      >
        {{ t("search.original") }}
      </n-tag>
    </template>

    <template #details="{ index }">
      <div v-if="!allowFullLyric && data[index].lyric_snippet" class="lyric-inline">
        <span class="lyric-badge">{{ t("search.lyric_badge") }}</span>
        <div class="lyric-lines">
          <n-ellipsis
            v-for="(line, lineIndex) in getLyricLines(data[index].lyric_snippet)"
            :key="lineIndex"
            class="lyric-line"
            :tooltip="{ placement: 'top', width: 'trigger' }"
          >
            <n-highlight :text="line" :patterns="getHighlightKeywords(data[index])" />
          </n-ellipsis>
        </div>
      </div>
      <n-button
        v-if="!allowFullLyric && data[index].sublist.length"
        class="versions-trigger"
        text
        type="primary"
        :aria-expanded="isExpanded(expandedVersions, index)"
        @click.stop="toggleExpanded('versions', index)"
        @dblclick.stop
      >
        <template #icon>
          <SvgIcon :name="isExpanded(expandedVersions, index) ? 'Up' : 'Down'" :size="14" />
        </template>
        {{ t("search.more_version") }} ({{ data[index].sublist.length }})
      </n-button>
    </template>

    <template #item-after="{ index }">
      <div
        v-if="
          allowFullLyric &&
          (data[index].lyric_snippet || data[index].lyric || data[index].sublist.length)
        "
        class="lyric-search-section"
        @click.stop
        @dblclick.stop
      >
        <div
          v-if="data[index].lyric_snippet && !isExpanded(expandedLyrics, index)"
          class="lyric-inline"
          @click="handleLyricSnippetClick($event, index)"
        >
          <div class="lyric-lines">
            <n-ellipsis
              v-for="(line, lineIndex) in getLyricLines(data[index].lyric_snippet)"
              :key="lineIndex"
              class="lyric-line"
              :tooltip="{ placement: 'top', width: 'trigger' }"
            >
              <n-highlight :text="line" :patterns="getHighlightKeywords(data[index])" />
            </n-ellipsis>
          </div>
        </div>
        <div
          v-if="data[index].lyric && isExpanded(expandedLyrics, index)"
          class="full-lyric"
          @click.stop="toggleExpanded('lyrics', index)"
        >
          <div
            v-for="(line, lineIndex) in getLyricLines(data[index].lyric)"
            :key="lineIndex"
            class="full-lyric-line"
          >
            <n-highlight :text="line" :patterns="getHighlightKeywords(data[index])" />
          </div>
        </div>
        <n-button
          v-if="data[index].lyric && !isExpanded(expandedLyrics, index)"
          class="lyrics-trigger"
          text
          type="primary"
          :aria-expanded="false"
          @click.stop="toggleExpanded('lyrics', index)"
          @dblclick.stop
        >
          <template #icon>
            <SvgIcon name="Down" :size="14" />
          </template>
          {{ t("search.expand_full_lyric") }}
        </n-button>
        <n-button
          v-if="data[index].lyric && isExpanded(expandedLyrics, index)"
          class="lyrics-trigger"
          text
          type="primary"
          :aria-expanded="true"
          @click.stop="toggleExpanded('lyrics', index)"
          @dblclick.stop
        >
          <template #icon>
            <SvgIcon name="Up" :size="14" />
          </template>
          {{ t("search.collapse_full_lyric") }}
        </n-button>
        <n-button
          v-if="data[index].sublist.length"
          class="versions-trigger"
          text
          type="primary"
          :aria-expanded="isExpanded(expandedVersions, index)"
          @click.stop="toggleExpanded('versions', index)"
          @dblclick.stop
        >
          <template #icon>
            <SvgIcon :name="isExpanded(expandedVersions, index) ? 'Up' : 'Down'" :size="14" />
          </template>
          {{ t("search.more_version") }} ({{ data[index].sublist.length }})
        </n-button>
      </div>
      <n-collapse-transition
        v-if="data[index].sublist.length"
        :show="isExpanded(expandedVersions, index)"
        @after-enter="refreshList"
        @after-leave="refreshList"
      >
        <div class="version-list" @click.stop @dblclick.stop>
          <SearchSongList
            :data="data[index].sublist"
            :keyword="keyword"
            :allow-full-lyric="allowFullLyric"
            height="auto"
            :show-header="false"
            :show-footer="false"
            @size-change="refreshList"
          />
        </div>
      </n-collapse-transition>
    </template>
  </SongList>
</template>

<script setup lang="ts">
import SongList from "@/components/List/SongList.vue";
import type { SearchSongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";

defineOptions({ name: "SearchSongList" });

const props = withDefaults(
  defineProps<{
    data: SearchSongInfo[];
    keyword: string;
    height?: number | "auto";
    loading?: boolean;
    loadMore?: boolean;
    showHeader?: boolean;
    showFooter?: boolean;
    allowFullLyric?: boolean;
  }>(),
  {
    loading: false,
    showHeader: true,
    showFooter: true,
    allowFullLyric: false,
  },
);

const emit = defineEmits<{
  reachBottom: [event: Event];
  sizeChange: [];
}>();

const { t } = useI18n();
const songListRef = ref<InstanceType<typeof SongList> | null>(null);
const expandedLyrics = ref<Set<string>>(new Set());
const expandedVersions = ref<Set<string>>(new Set());

const songs = computed(() => props.data.map((item) => item.song));
const highlightKeywords = computed(() => props.data.map(getHighlightKeywords));

const getItemKey = (index: number) => {
  const song = props.data[index].song;
  return `${song.platform}-${song.id}-${index}`;
};

const getHighlightKeywords = (item: SearchSongInfo): string[] => {
  const keywords = item.matched_keywords.length ? item.matched_keywords : [props.keyword];
  return [...new Set(keywords.map((word) => word.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
};

// 同时兼容真实换行符和平台歌词中未解码的 \n、\r\n，空行必须保留。
const getLyricLines = (lyric: string) => lyric.split(/\\r\\n|\\[rn]|\r\n|[\r\n]/);

const isExpanded = (state: Set<string>, index: number) => state.has(getItemKey(index));

const handleLyricSnippetClick = (event: MouseEvent, index: number) => {
  if (!props.allowFullLyric || !props.data[index].lyric) return;
  event.stopPropagation();
  toggleExpanded("lyrics", index);
};

const toggleExpanded = (type: "lyrics" | "versions", index: number) => {
  const state = type === "lyrics" ? expandedLyrics : expandedVersions;
  const next = new Set(state.value);
  const key = getItemKey(index);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  state.value = next;
  if (type === "lyrics") nextTick(refreshList);
};

const refreshList = () => {
  songListRef.value?.refreshMeasurements();
  emit("sizeChange");
};
</script>

<style lang="scss" scoped>
.original-tag {
  --n-height: 18px;
  font-size: 9px;
  pointer-events: none;
}

.lyrics-trigger,
.versions-trigger {
  align-self: flex-start;
  height: 20px;
  margin-top: 2px;
  font-size: 12px;
}

.lyric-inline {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  min-height: 20px;
  margin-top: 2px;
  font-size: 12px;
  opacity: 0.82;
  cursor: pointer;
}

.lyric-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  color: var(--primary-hex);
  background-color: rgba(var(--primary), 0.14);
  font-size: 10px;
  font-weight: 600;
}

.lyric-lines {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.lyric-line {
  width: 100%;
  min-height: 20px;
  line-height: 20px;
  white-space: pre;
}

.lyric-search-section {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-bottom: 12px;
  padding: 4px 12px 10px 126px;
  border: 2px solid rgba(var(--primary), 0.12);
  border-top: 0;
  border-radius: 0 0 12px 12px;
  background-color: var(--surface-container-hex);
}

.full-lyric {
  width: 100%;
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
}

.full-lyric-line {
  min-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

:deep(.virtual-item:has(> .lyric-search-section) > .song-card) {
  padding-bottom: 0;
}

:deep(.virtual-item:has(> .lyric-search-section) > .song-card .song-content) {
  border-bottom: 0;
  border-radius: 12px 12px 0 0;
}

:deep(.virtual-item:has(> .song-card .song-content.play) > .lyric-search-section) {
  border-color: rgba(var(--primary), 0.58);
  background-color: rgba(var(--primary), 0.28);
}

.version-list {
  margin: -8px 0 12px;
  padding-top: 10px;
  background-color: rgba(var(--primary), 0.04);
}

:deep(.n-highlight__mark) {
  color: var(--primary-hex);
  background-color: transparent;
  font-weight: 600;
}

@media (max-width: 512px) {
  .lyric-search-section {
    padding-left: 12px;
  }
}
</style>
