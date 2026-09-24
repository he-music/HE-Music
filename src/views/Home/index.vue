<template>
  <div class="home-page">
    <n-tabs
      v-if="availablePlatforms.length"
      :value="platform"
      class="tabs"
      type="bar"
      animated
      @update:value="platformChange"
    >
      <n-tab-pane
        v-for="item in supportPlatforms"
        :key="`recommend-${item.id}`"
        :name="item.id"
        :tab="item.shortname"
        :disabled="item.status !== 1"
        display-directive="show:lazy"
      >
        <RecommendOnline :platform="item.id" />
      </n-tab-pane>
    </n-tabs>
    <PageSectionSkeleton v-else-if="platformStore.loading" />
    <n-empty v-else :description="t('page_section.no_platform')" size="large" />
  </div>
</template>

<script setup lang="ts">
import { FeatureSupportFlag } from "@/api/platform";
import { usePlatformStore } from "@/stores";
import type { PlatformInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
import PageSectionSkeleton from "@/components/Page/PageSectionSkeleton.vue";
import RecommendOnline from "./RecommendOnline.vue";

const router = useRouter();
const platformStore = usePlatformStore();
const { t } = useI18n();

const supportPlatforms = computed<PlatformInfo[]>(
  () => platformStore.featureSupportList(FeatureSupportFlag.GetRecommendPage) || [],
);
const availablePlatforms = computed(() =>
  supportPlatforms.value.filter((platform) => platform.status === 1),
);

const platform = computed<string>(() => {
  const currentRoute = router.currentRoute.value;
  if (currentRoute.name !== "home") return "";
  return String(currentRoute.query.platform || "");
});

const scrollToTop = () => {
  nextTick(() => {
    document.querySelector<HTMLElement>("#main-content .n-scrollbar-container")?.scrollTo({
      top: 0,
      behavior: "auto",
    });
  });
};

const platformChange = (value: string) => {
  if (value === platform.value) return;
  router
    .replace({
      name: "home",
      query: { platform: value },
    })
    .then(scrollToTop);
};

watch(
  [availablePlatforms, platform, () => router.currentRoute.value.name],
  () => {
    if (router.currentRoute.value.name !== "home" || !availablePlatforms.value.length) return;
    if (!availablePlatforms.value.some((item) => item.id === platform.value)) {
      platformChange(availablePlatforms.value[0].id);
    }
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
.home-page {
  width: 100%;
  margin: 0 auto;

  .tabs {
    width: 100%;
    overflow: hidden;

    :deep(.n-tabs-pane-wrapper) {
      overflow: hidden;
    }
  }

  > .n-empty {
    margin-top: 72px;
  }
}
</style>
