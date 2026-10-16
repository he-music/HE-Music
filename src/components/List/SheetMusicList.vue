<template>
  <div class="sheet-list">
    <n-card v-for="sheet in data" :key="sheet.id" size="small" content-style="padding: 0">
      <button
        type="button"
        class="sheet-item"
        :disabled="!canGet || !sheet.id"
        @click="openDetail(sheet)"
      >
        <img v-if="sheet.cover" :src="sheet.cover" alt="" loading="lazy" class="cover" />
        <span class="sheet-info">
          <n-text strong class="sheet-title">{{
            sheet.title || sheet.song_name || t("sheet_music.untitled")
          }}</n-text>
          <span v-if="metadata(sheet).length" class="metadata">
            <n-tag
              v-for="(tag, index) in metadata(sheet)"
              :key="index"
              size="small"
              :bordered="false"
              >{{ tag }}</n-tag
            >
          </span>
          <span
            v-if="sheet.original_key?.trim() || (sheet.page_count ?? 0) > 0"
            class="sheet-facts"
          >
            <n-text v-if="sheet.original_key?.trim()" depth="2">
              {{
                t("sheet_music.original_key", {
                  key: sheet.original_key.trim().replace(/调$/, "").trim(),
                })
              }}
            </n-text>
            <n-text
              v-if="sheet.original_key?.trim() && (sheet.page_count ?? 0) > 0"
              depth="3"
              aria-hidden="true"
            >
              ·
            </n-text>
            <n-text v-if="(sheet.page_count ?? 0) > 0" depth="2">
              {{ t("sheet_music.page_count", { count: sheet.page_count }) }}
            </n-text>
          </span>
        </span>
      </button>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { FeatureSupportFlag } from "@/api/platform";
import { usePlatformStore } from "@/stores";
import type { SheetMusicInfo } from "@/types/main.hemusic";

const props = defineProps<{
  data: SheetMusicInfo[];
  platform: string;
  songId: string;
  songName?: string;
}>();

const { t } = useI18n();
const router = useRouter();
const platformStore = usePlatformStore();
const canGet = computed(() =>
  platformStore.isFeatureSupport(props.platform, FeatureSupportFlag.FeatureSupportGetSheetMusic),
);
const openDetail = (sheet: SheetMusicInfo) => {
  if (!canGet.value || !sheet.id) return;
  router.push({
    name: "sheet-music",
    query: {
      platform: props.platform,
      song_id: props.songId,
      id: sheet.id,
      ...(props.songName ? { song_name: props.songName } : {}),
    },
  });
};
const metadata = (sheet: SheetMusicInfo): string[] =>
  [
    ...(sheet.instruments ?? []),
    ...(sheet.notation_types ?? []),
    sheet.arrangement_type,
    sheet.difficulty,
  ].filter((value): value is string => !!value?.trim());
</script>

<style scoped lang="scss">
.sheet-list {
  display: grid;
  gap: 12px;
}
.sheet-item {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  padding: 12px 16px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  &:disabled {
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: -2px;
  }
}
.cover {
  width: 64px;
  height: 88px;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: 6px;
}
.sheet-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-wrap: anywhere;
}
.sheet-title {
  font-size: 17px;
  line-height: 1.5;
}
.metadata {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.sheet-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  font-size: 13px;
  margin-top: 4px;
}
</style>
