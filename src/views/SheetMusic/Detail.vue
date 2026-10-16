<template>
  <div class="sheet-music-detail-page">
    <header class="heading">
      <n-skeleton
        v-if="platformStore.loading || loading"
        class="title-skeleton"
        width="176px"
        height="28px"
      />
      <n-h2 v-else>{{ info?.title || t("sheet_music.title") }}</n-h2>
      <n-text v-if="songContext" depth="3">{{ songContext }}</n-text>
    </header>
    <SheetMusicState
      layout="detail"
      :loading="platformStore.loading || loading"
      :failed="platformFailed || failed"
      :not-implemented="notImplemented"
      :unsupported="!canGet ? t('sheet_music.detail_not_supported') : undefined"
      @retry="retryPage"
    >
      <template v-if="info">
        <div v-if="detailTags.length || detailFacts.length" class="score-info">
          <n-flex v-if="detailTags.length" class="tags" :size="8">
            <n-tag v-for="(tag, index) in detailTags" :key="index" size="small" :bordered="false">
              {{ tag }}
            </n-tag>
          </n-flex>
          <dl v-if="detailFacts.length" class="score-facts">
            <div v-for="fact in detailFacts" :key="fact.label" class="fact">
              <dt>
                <n-text depth="3">{{ fact.label }}</n-text>
              </dt>
              <dd>
                <n-text strong>{{ fact.value }}</n-text>
              </dd>
            </div>
          </dl>
        </div>
        <n-empty
          v-if="!pages.length"
          :description="t('sheet_music.resource_unavailable')"
          class="empty"
        >
          <template #extra>
            <n-button secondary round @click="retry">{{ t("page_section.retry") }}</n-button>
          </template>
        </n-empty>
        <SheetMusicReader v-else :pages="pages" @retry="retry" />
      </template>
    </SheetMusicState>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { FeatureSupportFlag } from "@/api/platform";
import { usePlatformStore } from "@/stores";
import { useSheetMusicDetail } from "@/composables/useSheetMusic";
import SheetMusicState from "@/components/SheetMusic/SheetMusicState.vue";
import SheetMusicReader from "@/components/SheetMusic/SheetMusicReader.vue";

defineOptions({ name: "SheetMusicDetail" });
const { t } = useI18n();
const route = useRoute();
const platformStore = usePlatformStore();
const platform = computed(() =>
  typeof route.query.platform === "string" ? route.query.platform : "",
);
const songId = computed(() => (typeof route.query.song_id === "string" ? route.query.song_id : ""));
const id = computed(() => (typeof route.query.id === "string" ? route.query.id : ""));
const songName = computed(() =>
  typeof route.query.song_name === "string" ? route.query.song_name : "",
);
const canGet = computed(() =>
  platformStore.isFeatureSupport(platform.value, FeatureSupportFlag.FeatureSupportGetSheetMusic),
);
const enabled = computed(
  () =>
    route.name === "sheet-music" &&
    canGet.value &&
    !!platform.value &&
    !!songId.value &&
    !!id.value,
);
const platformFailed = computed(() => !platformStore.loading && !platformStore.platforms.length);
const { info, pages, loading, failed, notImplemented, retry } = useSheetMusicDetail(
  platform,
  songId,
  id,
  enabled,
);
const retryPage = async () => {
  if (!platformStore.platforms.length) {
    await platformStore.loadPlatforms().catch(() => undefined);
  } else {
    await retry();
  }
};
const songContext = computed(() => info.value?.song_name || songName.value);
const detailTags = computed(() =>
  [
    ...(info.value?.instruments ?? []),
    ...(info.value?.notation_types ?? []),
    info.value?.arrangement_type,
  ].filter((value): value is string => !!value?.trim()),
);
const detailFacts = computed(() => {
  const sheet = info.value;
  if (!sheet) return [];
  const facts: { label: string; value: string }[] = [];
  if (sheet.uploader?.trim()) {
    facts.push({ label: t("sheet_music.uploader_label"), value: sheet.uploader });
  }
  if (sheet.difficulty?.trim()) {
    facts.push({ label: t("sheet_music.difficulty_label"), value: sheet.difficulty });
  }
  if (sheet.original_key?.trim()) {
    facts.push({ label: t("sheet_music.original_key_label"), value: sheet.original_key });
  }
  if (sheet.bpm && sheet.bpm > 0) {
    facts.push({ label: t("sheet_music.bpm_label"), value: `${sheet.bpm} BPM` });
  }
  if (sheet.page_count && sheet.page_count > 0) {
    facts.push({
      label: t("sheet_music.page_count_label"),
      value: t("sheet_music.pages", { count: sheet.page_count }),
    });
  }
  return facts;
});
</script>

<style scoped lang="scss">
.sheet-music-detail-page {
  padding: 16px 4px 24px;
  .heading {
    max-width: 1000px;
    margin: 0 auto 12px;
    overflow-wrap: anywhere;
    .n-h2,
    .title-skeleton {
      margin: 0 0 4px;
    }
  }
  .score-info {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px 20px;
    max-width: 1000px;
    margin: 0 auto 16px;
  }
  .score-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    margin: 0;
    .fact {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
    }
    dt {
      flex-shrink: 0;
      font-size: 13px;
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
      font-size: 13px;
    }
  }
  .empty {
    padding: 48px 0;
  }
}
</style>
