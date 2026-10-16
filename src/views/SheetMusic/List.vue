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
      <SheetMusicList
        v-else
        :data="sheets"
        :platform="platform"
        :song-id="songId"
        :song-name="songName"
      />
    </SheetMusicState>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { FeatureSupportFlag } from "@/api/platform";
import { usePlatformStore } from "@/stores";
import { useSheetMusicList } from "@/composables/useSheetMusic";
import SheetMusicState from "@/components/SheetMusic/SheetMusicState.vue";
import SheetMusicList from "@/components/List/SheetMusicList.vue";

defineOptions({ name: "SheetMusicList" });
const { t } = useI18n();
const route = useRoute();
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
}
</style>
