<template>
  <div class="discover-page platform-page">
    <PagePlatformTabs
      v-if="availablePlatforms.length"
      :value="platform"
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
import DiscoverOnline from "./DiscoverOnline.vue";

const router = useRouter();
const platformStore = usePlatformStore();

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

  > .n-empty {
    margin-top: 72px;
  }
}
</style>
