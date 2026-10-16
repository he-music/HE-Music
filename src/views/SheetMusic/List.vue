<template>
  <div class="sheet-music-list-page">
    <n-h2 class="heading">{{ title }}</n-h2>
    <SheetMusicState
      :loading="platformStore.loading || loading"
      :failed="platformFailed || failed"
      :not-implemented="notImplemented"
      :unsupported="!canList ? t('sheet_music.list_not_supported') : undefined"
      @retry="retryPage"
    >
      <n-alert v-if="!canGet" type="info" :bordered="false" class="notice">
        {{ t("sheet_music.detail_not_supported") }}
      </n-alert>
      <n-empty v-if="!sheets.length" :description="t('sheet_music.empty')" class="empty" />
      <div v-else class="sheet-list">
        <n-card v-for="sheet in sheets" :key="sheet.id" size="small" content-style="padding: 0">
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
              <n-text v-if="sheet.uploader" depth="3" class="uploader">
                {{ t("sheet_music.uploader", { name: sheet.uploader }) }}
              </n-text>
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
                  {{ t("sheet_music.original_key", { key: sheet.original_key }) }}
                </n-text>
                <n-text v-if="(sheet.page_count ?? 0) > 0" depth="2">
                  {{ t("sheet_music.page_count", { count: sheet.page_count }) }}
                </n-text>
              </span>
            </span>
          </button>
        </n-card>
      </div>
    </SheetMusicState>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { FeatureSupportFlag } from "@/api/platform";
import { usePlatformStore } from "@/stores";
import { useSheetMusicList } from "@/composables/useSheetMusic";
import SheetMusicState from "@/components/SheetMusic/SheetMusicState.vue";
import type { SheetMusicInfo } from "@/types/main.hemusic";

defineOptions({ name: "SheetMusicList" });
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const platformStore = usePlatformStore();
const platform = computed(() =>
  typeof route.query.platform === "string" ? route.query.platform : "",
);
const songId = computed(() => (typeof route.query.song_id === "string" ? route.query.song_id : ""));
const routeSongName = computed(() =>
  typeof route.query.song_name === "string" ? route.query.song_name : "",
);
const canList = computed(() =>
  platformStore.isFeatureSupport(platform.value, FeatureSupportFlag.FeatureSupportListSheetMusic),
);
const canGet = computed(() =>
  platformStore.isFeatureSupport(platform.value, FeatureSupportFlag.FeatureSupportGetSheetMusic),
);
const enabled = computed(
  () => route.name === "song-sheet-music" && canList.value && !!platform.value && !!songId.value,
);
const platformFailed = computed(() => !platformStore.loading && !platformStore.platforms.length);
const { sheets, loading, failed, notImplemented, retry } = useSheetMusicList(
  platform,
  songId,
  enabled,
);
const songName = computed(
  () => routeSongName.value || sheets.value.find((sheet) => sheet.song_name)?.song_name || "",
);
const title = computed(() =>
  songName.value ? t("sheet_music.song_title", { name: songName.value }) : t("sheet_music.title"),
);
const retryPage = async () => {
  if (!platformStore.platforms.length) {
    await platformStore.loadPlatforms().catch(() => undefined);
  } else {
    await retry();
  }
};
const openDetail = (sheet: SheetMusicInfo) => {
  if (!canGet.value || !sheet.id) return;
  router.push({
    name: "sheet-music",
    query: {
      platform: platform.value,
      song_id: songId.value,
      id: sheet.id,
      ...(songName.value ? { song_name: songName.value } : {}),
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
.sheet-music-list-page {
  padding: 20px 4px 32px;
  .heading {
    margin-bottom: 24px;
    overflow-wrap: anywhere;
  }
  .notice {
    margin-bottom: 16px;
  }
  .empty {
    padding: 48px 0;
  }
  .sheet-list {
    display: grid;
    gap: 12px;
  }
  .sheet-item {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    width: 100%;
    padding: 16px;
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
    width: 80px;
    height: 108px;
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
  .uploader {
    font-size: 13px;
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
    gap: 8px 24px;
    font-size: 13px;
    margin-top: 4px;
  }
}
</style>
