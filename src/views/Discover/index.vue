<template>
  <div class="discover-page">
    <n-tabs
      v-if="availablePlatforms.length"
      :value="platform"
      class="tabs"
      type="bar"
      animated
      @update:value="platformChange"
    >
      <n-tab-pane
        v-for="platform in supportPlatforms"
        :key="`discover-${platform.id}`"
        :name="platform.id"
        :tab="platform.shortname"
        :disabled="platform.status !== 1"
        display-directive="show:lazy"
      >
        <DiscoverOnline :platform="platform.id" />
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
import DiscoverOnline from "./DiscoverOnline.vue";

const router = useRouter();
const platformStore = usePlatformStore();
const { t } = useI18n();

const supportPlatforms = computed<PlatformInfo[]>(
  () => platformStore.featureSupportList(FeatureSupportFlag.GetDiscoverPage) || [],
);
const availablePlatforms = computed(() =>
  supportPlatforms.value.filter((platform) => platform.status === 1),
);

const platform = computed<string>(() => {
  const currentRoute = router.currentRoute.value;
  if (currentRoute.name !== "discover") return "";
  return String(currentRoute.query.platform || "");
});

const platformChange = (value: string) => {
  if (value === platform.value) return;
  router.replace({
    name: "discover",
    query: { platform: value },
  });
};

watch(
  [availablePlatforms, platform, () => router.currentRoute.value.name],
  () => {
    if (router.currentRoute.value.name !== "discover" || !availablePlatforms.value.length) return;
    if (!availablePlatforms.value.some((item) => item.id === platform.value)) {
      platformChange(availablePlatforms.value[0].id);
    }
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
.discover-page {
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
