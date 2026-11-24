<template>
  <div class="copy-lyrics">
    <n-scrollbar class="lyrics-list">
      <n-checkbox-group v-model:value="selectedLines" :disabled="exporting">
        <n-list hoverable>
          <n-list-item v-for="line in displayLyrics" :key="line.index">
            <n-checkbox :value="line.index" class="lyric-checkbox">
              <n-flex size="small" class="lyric-content" vertical>
                <n-text v-if="line.text" class="text">{{ line.text }}</n-text>
                <n-text v-if="showTranslation && line.translation" depth="1" class="translation">
                  {{ line.translation }}
                </n-text>
                <n-text v-if="showRomaji && line.romaji" depth="3" class="romaji">
                  {{ line.romaji }}
                </n-text>
              </n-flex>
            </n-checkbox>
          </n-list-item>
        </n-list>
      </n-checkbox-group>
    </n-scrollbar>
    <div class="footer">
      <n-flex align="center" justify="space-between" size="small">
        <n-checkbox-group v-model:value="selectedFilters" :disabled="exporting">
          <n-flex align="center" size="small">
            <n-checkbox value="translation" :label="t('lyric_card.translation')" />
            <n-checkbox value="romaji" :label="t('lyric_card.romaji')" />
          </n-flex>
        </n-checkbox-group>
        <n-flex align="center" size="small" class="actions">
          <n-button size="small" :disabled="exporting || !displayLyrics.length" @click="selectAll">
            {{ t("lyric_card.select_all") }}
          </n-button>
          <n-button
            size="small"
            type="primary"
            :disabled="exporting || !selectedLines.length"
            @click="handleCopy"
          >
            {{ t("lyric_card.copy", { count: selectedLines.length }) }}
          </n-button>
          <n-button
            size="small"
            :disabled="exporting || !selectedLines.length"
            :loading="exporting"
            @click="handleExport"
          >
            {{ t(saveMode === "download" ? "lyric_card.download_png" : "lyric_card.save_png") }}
          </n-button>
        </n-flex>
      </n-flex>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { t } from "@/i18n";
import {
  createLyricCardPng,
  downloadLyricCardPng,
  lyricCardFilename,
  LyricCardTooLargeError,
} from "./lyricCard";
import {
  encodeLyricCardPng,
  pickLyricCardFile,
  supportsLyricCardPicker,
  writeLyricCardFile,
} from "./lyricCardSave";
import { platform } from "@/platform";
import { filesSession } from "@/platform/filesSession";
import { useMusicStore } from "@/stores/music";
import { copyData } from "@/utils/helper";

const props = defineProps<{ onClose: () => void }>();

const musicStore = useMusicStore();

const selectedFilters = ref<string[]>(["translation", "romaji"]);
const selectedLines = ref<number[]>([]);
const exporting = ref(false);
const saveMode =
  platform.kind === "mygo" ? "desktop" : supportsLyricCardPicker() ? "picker" : "download";
const exportLifetime = new AbortController();
onScopeDispose(() => exportLifetime.abort());

const rawLyrics = computed(() => {
  const { songLyric } = musicStore;
  return songLyric.yrcData?.length ? songLyric.yrcData : songLyric.lrcData;
});

const previousSongLyrics = shallowRef<typeof rawLyrics.value>();
watch(
  [rawLyrics, () => musicStore.playSong.id, () => musicStore.playSong.platform],
  ([lyrics, songId, platform], [lastLyrics, lastSongId, lastPlatform]) => {
    selectedLines.value = [];
    // 切歌时，歌词库可能尚未替换旧内容。
    if (lyrics !== lastLyrics) previousSongLyrics.value = undefined;
    else if (songId !== lastSongId || platform !== lastPlatform) previousSongLyrics.value = lyrics;
  },
);

const displayLyrics = computed(() => {
  if (rawLyrics.value === previousSongLyrics.value) return [];
  return rawLyrics.value.map((line, index) => {
    const text = line.words?.map((w) => w.word).join("") || "";
    const translation = line.translatedLyric || "";
    const romaji = line.romanLyric || line.words?.map((w) => w.romanWord).join("") || "";
    return {
      index,
      text,
      translation,
      romaji,
    };
  });
});

const showTranslation = computed(() => selectedFilters.value.includes("translation"));
const showRomaji = computed(() => selectedFilters.value.includes("romaji"));

const selectAll = () => {
  if (selectedLines.value.length === displayLyrics.value.length) {
    selectedLines.value = [];
  } else {
    selectedLines.value = displayLyrics.value.map((l) => l.index);
  }
};

const selectedLyricParts = computed(() => {
  const selection = new Set(selectedLines.value);
  return displayLyrics.value
    .filter((line) => selection.has(line.index))
    .map((line) =>
      [
        line.text,
        showTranslation.value ? line.translation : "",
        showRomaji.value ? line.romaji : "",
      ].filter(Boolean),
    )
    .filter((parts) => parts.length > 0);
});

const handleCopy = async () => {
  if (exporting.value) return;
  const text = selectedLyricParts.value.map((parts) => parts.join("\n")).join("\n\n");
  if (!text) {
    window.$message.warning(t("lyric_card.no_copy_content"));
    return;
  }
  await copyData(text);
  props.onClose();
};

const handleExport = async () => {
  const { signal } = exportLifetime;
  if (exporting.value || signal.aborted) return;
  const lyrics = selectedLyricParts.value
    .map((parts) => parts.map((part) => part.trim()).filter(Boolean))
    .filter((parts) => parts.length > 0);
  if (!lyrics.length) {
    window.$message.warning(t("lyric_card.no_export_content"));
    return;
  }

  exporting.value = true;
  try {
    const song = musicStore.playSong;
    const title = song.name?.trim() || t("lyric_card.unknown_song");
    const artist =
      (Array.isArray(song.artists)
        ? song.artists
            .map(({ name }) => name.trim())
            .filter(Boolean)
            .join(" / ")
        : song.artists?.trim()) || t("common.unknown_artist");
    const coverUrl = musicStore.songCover;
    const filename = lyricCardFilename(title);
    const target = saveMode === "picker" ? await pickLyricCardFile(filename) : null;
    if (signal.aborted || (saveMode === "picker" && !target)) return;

    const png = await createLyricCardPng(
      {
        title,
        artist,
        lyrics,
        coverUrl: coverUrl === "/images/song.jpg?asset" ? undefined : coverUrl,
      },
      signal,
    );
    if (signal.aborted) return;

    if (saveMode === "desktop") {
      const payload = await encodeLyricCardPng(png);
      if (signal.aborted) return;
      const result = await filesSession.value?.saveLyricCard(filename, payload);
      if (signal.aborted || result?.status === "stale") return;
      if (result?.status === "busy") {
        window.$message.warning(t("message.settings_file_busy"));
        return;
      }
      if (result?.status !== "completed") throw new Error("Desktop save failed");
      if (result.value === "cancelled") return;
    } else if (target) {
      await writeLyricCardFile(target, png, signal);
    } else {
      downloadLyricCardPng(png, filename);
      window.$message.info(t("lyric_card.download_started"));
      return;
    }
    if (!signal.aborted) window.$message.success(t("lyric_card.saved"));
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof LyricCardTooLargeError) {
      window.$message.warning(t("lyric_card.too_large"));
    } else {
      window.$message.error(t("lyric_card.export_failed"));
    }
  } finally {
    exporting.value = false;
  }
};
</script>

<style lang="scss" scoped>
.copy-lyrics {
  display: flex;
  flex-direction: column;
  height: 60vh;
  height: 60dvh;
  min-height: 240px;
  width: 100%;
}

.lyrics-list {
  flex: 1;
  min-height: 0;

  .lyric-checkbox {
    width: 100%;

    :deep(.n-checkbox__label) {
      min-width: 0;
      overflow-wrap: anywhere;
    }
  }

  .lyric-content {
    font-size: 14px;
    line-height: 1.6;
    .translation {
      font-size: 12px;
    }
    .romaji {
      font-size: 12px;
      font-style: italic;
    }
  }
}

.footer {
  margin-top: 12px;

  .actions {
    margin-inline-start: auto;
  }
}
</style>
