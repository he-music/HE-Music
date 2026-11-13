<template>
  <div class="videos platform-page">
    <PagePlatformTabs :value="platform" @update:value="platformChange">
      <n-tab-pane
        v-for="platform in supportPlatforms"
        :key="`artists-${platform.id}`"
        :name="platform.id"
        :tab="platform.shortname"
        :disabled="platform.status !== 1"
        display-directive="show:lazy"
      >
        <VideosResult :platform="platform.id" />
      </n-tab-pane>
    </PagePlatformTabs>
  </div>
</template>

<script setup lang="ts">
import PagePlatformTabs from "@/components/Page/PagePlatformTabs.vue";
import { usePlatformStore } from "@/stores";
import { onBeforeRouteUpdate } from "vue-router";
import { computed, onActivated, watch } from "vue";
import { FeatureSupportFlag } from "@/api/platform";
import type { PlatformInfo } from "@/types/main.hemusic";
import VideosResult from "@/views/Videos/VideosResult.vue";

const router = useRouter();
const platformStore = usePlatformStore();
const supportPlatforms = computed<PlatformInfo[]>(
  () => platformStore.featureSupportList(FeatureSupportFlag.FeatureSupportListMVFilters) || [],
);
const platform = computed<string>(() => {
  // 只有当前路由是 ranking-list 时才返回 platform，否则返回空字符串
  const currentRoute = router.currentRoute.value;
  if (currentRoute.name !== "videos") {
    return "";
  }
  return currentRoute.query.platform as string;
});

const platformChange = (value: string) => {
  router.replace({
    name: "videos",
    query: {
      platform: value,
    },
  });
};

onBeforeRouteUpdate((to) => {
  const targetPlatform = to.query.platform as string;
  if (
    supportPlatforms.value.length > 0 &&
    !supportPlatforms.value.find((p) => p.id === targetPlatform && p.status === 1)
  ) {
    platformChange(supportPlatforms.value[0]?.id);
  }
});

onActivated(() => {
  if (
    supportPlatforms.value.length > 0 &&
    !supportPlatforms.value.find((p) => p.id === platform.value && p.status === 1)
  ) {
    platformChange(supportPlatforms.value[0]?.id);
  }
});

const watcher = watch(
  () => platformStore.platforms,
  async () => {
    watcher.stop();
    if (
      supportPlatforms.value.length > 0 &&
      !supportPlatforms.value.find((p) => p.id === platform.value && p.status === 1)
    ) {
      platformChange(supportPlatforms.value[0]?.id);
    }
  },
);
</script>

<style lang="scss" scoped>
.videos {
  display: flex;
  flex-direction: column;
}
</style>
