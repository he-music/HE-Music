<template>
  <div class="artists">
    <n-tabs
      v-model:value="platform"
      class="tabs"
      type="bar"
      animated
      @update:value="platformChange"
    >
      <n-tab-pane
        v-for="platform in supportPlatforms"
        :key="`artists-${platform.id}`"
        :name="platform.id"
        :tab="platform.shortname"
        :disabled="platform.status !== 1"
        display-directive="show:lazy"
      >
        <ArtistsResult :platform="platform.id" />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
import { usePlatformStore } from "@/stores";
import { onBeforeRouteUpdate } from "vue-router";
import { computed, onActivated, watch } from "vue";
import { FeatureSupportFlag } from "@/api/platform";
import type { PlatformInfo } from "@/types/main.hemusic";
import ArtistsResult from "@/views/Artists/ArtistsResult.vue";

const router = useRouter();
const platformStore = usePlatformStore();
const supportPlatforms = computed<PlatformInfo[]>(
  () => platformStore.featureSupportList(FeatureSupportFlag.ListArtistTabs) || [],
);
const platform = computed<string>(() => {
  // 只有当前路由是 ranking-list 时才返回 platform，否则返回空字符串
  const currentRoute = router.currentRoute.value;
  if (currentRoute.name !== "artists") {
    return "";
  }
  return currentRoute.query.platform as string;
});

const platformChange = (value: string) => {
  router.replace({
    name: "artists",
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
.artists {
  display: flex;
  flex-direction: column;
  .tabs {
    width: 100%;
    overflow: hidden;
    :deep(.n-tabs-pane-wrapper) {
      overflow: hidden;
    }
  }
}
</style>
