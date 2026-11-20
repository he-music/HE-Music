<template>
  <div class="playlist-square platform-page">
    <PagePlatformTabs :value="activePlatform" @update:value="platformChange">
      <n-tab-pane
        v-for="platform in supportPlatforms"
        :key="`playlist-square-${platform.id}`"
        :name="platform.id"
        :tab="platform.shortname"
        :disabled="platform.status !== 1"
        display-directive="show:lazy"
      >
        <PlaylistSquareResult
          :platform="platform.id"
          :category_id="
            platform.id === activePlatform ? categoryId : selectedCategories.get(platform.id)
          "
          @change="tagChange"
        />
      </n-tab-pane>
    </PagePlatformTabs>
  </div>
</template>

<script setup lang="ts">
import PagePlatformTabs from "@/components/Page/PagePlatformTabs.vue";
import { usePlatformStore } from "@/stores";
import { onBeforeRouteUpdate } from "vue-router";
import PlaylistSquareResult from "@/views/PlaylistSquare/PlaylistSquareResult.vue";
import { computed, onActivated, watch } from "vue";
import { FeatureSupportFlag } from "@/api/platform";
import type { PlatformInfo } from "@/types/main.hemusic";

const router = useRouter();
const platformStore = usePlatformStore();
const supportPlatforms = computed<PlatformInfo[]>(
  () => platformStore.featureSupportList(FeatureSupportFlag.GetTagList) || [],
);
const selectedCategories = reactive(new Map<string, string>());
const playlistQuery = computed(() => {
  const route = router.currentRoute.value;
  return route.name === "playlist-square" ? route.query : {};
});
const activePlatform = computed(() => {
  const value = playlistQuery.value.platform;
  return typeof value === "string" ? value : undefined;
});
const categoryId = computed(() => {
  const value = playlistQuery.value.category_id;
  return typeof value === "string" ? value : undefined;
});

watch(
  [activePlatform, categoryId],
  ([platform, category]) => {
    if (!platform) return;
    if (category) selectedCategories.set(platform, category);
    else selectedCategories.delete(platform);
  },
  { immediate: true },
);

const platformChange = (value: string) => {
  if (value === activePlatform.value) return;
  router.replace({
    name: "playlist-square",
    query: {
      platform: value,
      category_id: selectedCategories.get(value),
    },
  });
};

const tagChange = (categoryId: string) => {
  router.replace({
    name: "playlist-square",
    query: {
      platform: activePlatform.value,
      category_id: categoryId,
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
    !supportPlatforms.value.find((p) => p.id === activePlatform.value && p.status === 1)
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
      !supportPlatforms.value.find((p) => p.id === activePlatform.value && p.status === 1)
    ) {
      platformChange(supportPlatforms.value[0]?.id);
    }
  },
);
</script>

<style lang="scss" scoped>
.playlist-square {
  display: flex;
  flex-direction: column;
  width: 100%;

  :deep(.page-platform-tabs > .n-tabs > .n-tab-pane) {
    padding-top: 0;
  }
}
</style>
