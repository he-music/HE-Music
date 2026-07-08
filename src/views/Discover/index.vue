<template>
  <div class="home">
    <n-tabs
      v-if="true"
      v-model:value="platform"
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
        <HomeOnline :platform="platform.id" />
      </n-tab-pane>
    </n-tabs>
    <n-flex v-else wrap class="tabs">
      <n-skeleton v-for="i in 5" :key="'tag1-' + i" text :width="60" :height="30" round />
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { usePlatformStore } from "@/stores";
import HomeOnline from "./HomeOnline.vue";
import { FeatureSupportFlag } from "@/api/platform";
import { computed, onActivated, watch } from "vue";
import type { PlatformInfo } from "@/types/main.hemusic";

const router = useRouter();
const platformStore = usePlatformStore();

const supportPlatforms = computed<PlatformInfo[]>(
  () => platformStore.featureSupportList(FeatureSupportFlag.GetDiscoverPage) || [],
);

const platform = computed<string>(() => {
  // 只有当前路由是 ranking-list 时才返回 platform，否则返回空字符串
  const currentRoute = router.currentRoute.value;
  if (currentRoute.name !== "discover") {
    return "";
  }
  return currentRoute.query.platform as string;
});

const platformChange = (value: string) => {
  router.push({
    name: "discover",
    query: {
      platform: value,
    },
  });
};

onBeforeRouteUpdate((to) => {
  let targetPlatform = to.query.platform as string;
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
.home {
  width: 100%;
  //max-width: 1500px;
  margin: 0 auto;
  .tabs {
    width: 100%;
    overflow: hidden;
    :deep(.n-tabs-pane-wrapper) {
      overflow: hidden;
    }
  }
}
</style>
