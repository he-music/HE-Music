<template>
  <div class="home-page platform-page">
    <PagePlatformTabs
      v-if="availablePlatforms.length"
      :value="platform"
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
    </PagePlatformTabs>
    <PageSectionSkeleton v-else-if="platformStore.loading" />
    <PlatformAccessEmpty v-else />
  </div>
</template>

<script setup lang="ts">
import PagePlatformTabs from "@/components/Page/PagePlatformTabs.vue";
import { FeatureSupportFlag } from "@/api/platform";
import { usePlatformStore } from "@/stores";
import type { PlatformInfo } from "@/types/main.hemusic";
import PageSectionSkeleton from "@/components/Page/PageSectionSkeleton.vue";
import PlatformAccessEmpty from "@/components/Page/PlatformAccessEmpty.vue";
import RecommendOnline from "./RecommendOnline.vue";

const router = useRouter();
const platformStore = usePlatformStore();

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

const platformChange = (value: string) => {
  if (value === platform.value) return;
  router.replace({
    name: "home",
    query: { platform: value },
  });
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

  > .n-empty {
    margin-top: 72px;
  }
}
</style>
