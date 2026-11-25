<template>
  <div class="lyric-search">
    <form class="search-form" @submit.prevent="search">
      <label class="field">
        {{ t("lyricSearch.platform") }}
        <n-select
          :value="platform"
          :options="platformOptions"
          :disabled="saving"
          @update:value="changePlatform"
        />
      </label>
      <label class="field">
        {{ t("lyricSearch.song") }}
        <n-input v-model:value="name" :disabled="saving" />
      </label>
      <label class="field">
        {{ t("lyricSearch.artist") }}
        <n-input v-model:value="artists" :disabled="saving" />
      </label>
      <n-button attr-type="submit" :disabled="!canSubmit" :loading="searching" type="primary">
        {{ t("lyricSearch.search") }}
      </n-button>
    </form>

    <div class="results">
      <ul class="candidates" :aria-label="t('lyricSearch.candidates')">
        <li v-for="candidate in candidates" :key="candidate.id">
          <button
            type="button"
            class="candidate"
            :aria-pressed="active?.id === candidate.id"
            :disabled="saving"
            @click="preview(candidate)"
          >
            <span class="candidate-title">{{ candidate.name }}</span>
            <span class="candidate-meta">
              {{ candidate.artist_names?.join(" / ") }}
              <span v-if="candidate.duration && candidate.duration > 0">
                {{ secondsToTime(candidate.duration) }}
              </span>
            </span>
          </button>
        </li>
      </ul>
      <section
        class="preview"
        :aria-label="t('lyricSearch.preview')"
        :aria-busy="searching || previewing"
      >
        <LyricTimingPreview
          v-if="selectedLyric"
          v-show="!previewing"
          :visible="!previewing"
          :lyrics="selectedLyric.parsed"
          :track-key="targetKey ?? ''"
        />
        <div v-if="searching || previewing || !selectedLyric" class="preview-status" role="status">
          <n-spin
            v-if="searching || previewing"
            size="small"
            :aria-label="t(searching ? 'lyricSearch.searching' : 'lyricSearch.loadingPreview')"
          />
          <span v-else>{{ t(notice) }}</span>
        </div>
      </section>
    </div>
    <div class="actions">
      <n-button :disabled="saving" @click="close">{{ t("common.cancel") }}</n-button>
      <n-button
        type="primary"
        :disabled="!selectedLyric || previewing"
        :loading="saving"
        @click="apply"
      >
        {{ t("lyricSearch.apply") }}
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { getLyricCandidate, searchLyricCandidates, type LyricCandidate } from "@/api/lyrics";
import { useMusicStore } from "@/stores/music";
import { useLyricSearchPlatforms } from "@/composables/useManualLyricActions";
import type { LyricInfo, SongInfo } from "@/types/main.hemusic";
import type { SongLyric } from "@/types/lyric";
import { secondsToTime } from "@/utils/time";
import { hasLyricText, parseSongLyric } from "@/utils/lyric";
import lyricManager from "@/utils/lyricManager";
import { manualLyricKey } from "@/utils/manualLyricRecord";
import { usePlayer } from "@/utils/player";
import LyricTimingPreview from "./LyricTimingPreview.vue";

const { target, onClose } = defineProps<{ target: SongInfo; onClose: () => void }>();
const { t } = useI18n();
const music = useMusicStore();
const player = usePlayer();
const targetKey = manualLyricKey(target);
const currentKey = computed(() => manualLyricKey(music.playSong));
const platforms = useLyricSearchPlatforms();
const platformOptions = computed(() =>
  platforms.value.map((p) => ({ label: p.name, value: p.id })),
);
const name = ref(target.name);
const artists = ref(
  Array.isArray(target.artists)
    ? target.artists.map((artist) => artist.name).join("、")
    : (target.artists ?? ""),
);
const artistNames = computed(() =>
  artists.value
    .split(/[、,，]/)
    .map((v) => v.trim())
    .filter(Boolean),
);
const platform = ref<string | null>(null);
const candidates = shallowRef<LyricCandidate[]>([]);
const active = shallowRef<LyricCandidate>();
const selectedLyric = shallowRef<{ raw: LyricInfo; parsed: SongLyric }>();
const searching = ref(false);
const previewing = ref(false);
const saving = ref(false);
const searchNotice = ref("");
const previewNotice = ref("");
const notice = computed(() => {
  if (!platform.value) return "lyricSearch.noPlatforms";
  return searchNotice.value || previewNotice.value || "lyricSearch.choosePreview";
});
const canSubmit = computed(
  () => !!platform.value && !!name.value.trim() && !!artistNames.value.length && !saving.value,
);

let searchRequest: AbortController | undefined;
let previewRequest: AbortController | undefined;
let closed = false;

function resetResults() {
  searchRequest?.abort();
  previewRequest?.abort();
  candidates.value = [];
  active.value = undefined;
  selectedLyric.value = undefined;
  searching.value = false;
  previewing.value = false;
  searchNotice.value = "";
  previewNotice.value = "";
}

function close() {
  if (closed) return;
  closed = true;
  resetResults();
  onClose();
}

onScopeDispose(() => {
  closed = true;
  searchRequest?.abort();
  previewRequest?.abort();
});
watch(
  currentKey,
  (key) => {
    if (key !== targetKey) close();
  },
  { flush: "sync" },
);
watch([name, artists], resetResults, { flush: "sync" });

function changePlatform(value: string | null) {
  if (platform.value === value) return;
  platform.value = value;
  resetResults();
  if (canSubmit.value) void search();
}

watch(
  platforms,
  (items) => {
    if (items.some(({ id }) => id === platform.value)) return;
    changePlatform(items.find(({ id }) => id === target.platform)?.id ?? items[0]?.id ?? null);
  },
  { immediate: true },
);

async function search() {
  if (!platform.value || !canSubmit.value || closed) return;
  resetResults();
  const controller = (searchRequest = new AbortController());
  searching.value = true;
  const album = typeof target.album === "string" ? target.album : target.album?.name;
  const duration =
    Number.isFinite(target.duration) && target.duration > 0
      ? target.duration
      : player.getDuration() / 1000;
  try {
    const matches = await searchLyricCandidates(
      {
        platform: platform.value,
        name: name.value.trim(),
        artist_names: artistNames.value,
        album_name: album || undefined,
        duration: Number.isFinite(duration) ? Math.max(0, Math.floor(duration)) : 0,
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    candidates.value = matches;
    if (!matches.length) searchNotice.value = "lyricSearch.noResults";
  } catch {
    if (!controller.signal.aborted) searchNotice.value = "lyricSearch.searchFailed";
  } finally {
    if (!controller.signal.aborted) searching.value = false;
  }
}

async function preview(candidate: LyricCandidate) {
  if (
    closed ||
    saving.value ||
    (active.value === candidate && (selectedLyric.value || previewing.value))
  )
    return;
  previewRequest?.abort();
  const controller = (previewRequest = new AbortController());
  active.value = candidate;
  previewNotice.value = "";
  previewing.value = true;
  try {
    const result = await getLyricCandidate(candidate, controller.signal);
    if (controller.signal.aborted) return;
    const parsed = parseSongLyric(result);
    if (hasLyricText(parsed)) selectedLyric.value = { raw: result, parsed };
    else {
      selectedLyric.value = undefined;
      previewNotice.value = "lyricSearch.unusable";
    }
  } catch {
    if (!controller.signal.aborted) {
      selectedLyric.value = undefined;
      previewNotice.value = "lyricSearch.previewFailed";
    }
  } finally {
    if (!controller.signal.aborted) previewing.value = false;
  }
}

async function apply() {
  const lyric = selectedLyric.value?.raw;
  if (
    !lyric ||
    !targetKey ||
    currentKey.value !== targetKey ||
    closed ||
    saving.value ||
    previewing.value
  )
    return;
  saving.value = true;
  try {
    await lyricManager.saveManualLyric(targetKey, lyric);
    if (currentKey.value === targetKey) await player.reloadTrackLyrics();
    if (closed) return;
    window.$message.success(t("lyricSearch.applied"));
    close();
  } catch {
    if (!closed) window.$message.error(t("lyricSearch.saveFailed"));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.lyric-search {
  display: grid;
  gap: 12px;
  max-height: 72dvh;
  overflow-y: auto;
}
.search-form {
  display: grid;
  grid-template-columns: minmax(110px, 0.8fr) minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: end;
  gap: 8px;
}
.field {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.results {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  grid-template-rows: clamp(144px, 36dvh, 320px);
  gap: 8px;
}
.candidates {
  overflow: auto;
  min-height: 0;
  padding: 4px;
  margin: 0;
  list-style: none;
}
.preview {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: 8px;
  background: #24282c;
  color: #efefef;
}
.preview-status {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  padding: 12px;
  text-align: center;
  font-size: 0.9em;
}
.candidate {
  appearance: none;
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
  &[aria-pressed="true"] {
    border-color: currentColor;
  }
}
.candidate-title,
.candidate-meta {
  overflow-wrap: anywhere;
}
.candidate-meta {
  opacity: 0.78;
  font-size: 0.9em;
}
.candidate-meta span {
  margin-inline-start: 4px;
}
.actions {
  display: flex;
  justify-content: end;
  gap: 8px;
}
@media (max-width: 560px) {
  .search-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .results {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: clamp(66px, 13dvh, 112px) clamp(132px, 28dvh, 220px);
  }
}
</style>
