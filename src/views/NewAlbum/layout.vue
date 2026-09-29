<template>
  <AsyncContent class="new-song" :failed="failed" :loading="loading" @retry="retry">
    <n-skeleton v-if="loading" height="40px" />
    <n-tabs
      v-else
      v-model:value="tab_id"
      class="tabs"
      type="bar"
      animated
      @update:value="tagChange"
    >
      <n-tab-pane
        v-for="tab in tabs"
        :key="`new-song-${tab.platform}-${tab.id}`"
        :name="tab.id"
        :tab="tab.name"
        display-directive="show:lazy"
      >
        <NewAlbumResult :platform="tab.platform" :tab_id="tab.id" />
      </n-tab-pane>
    </n-tabs>
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { useAsyncRequest } from "@/composables/useAsyncRequest";
import type { TabInfo } from "@/types/main.hemusic";

import { usePlatformStore } from "@/stores";
import NewAlbumResult from "@/views/NewAlbum/NewAlbumResult.vue";
import { newAlbumTabs } from "@/api/album";

const router = useRouter();
const platformStore = usePlatformStore();

const tab_id = ref<string>(router.currentRoute.value.query?.tab_id as string);
const platform = ref<string>(router.currentRoute.value.query?.platform as string);

const tagChange = (tab_id: string) => {
  router.replace({
    name: "new-album",
    query: {
      tab_id: tab_id,
      platform: platform.value,
    },
  });
};
const {
  data: tabs,
  loading,
  failed,
  retry,
  reset: getTabList,
} = useAsyncRequest<TabInfo[]>(async () => {
  const result = await newAlbumTabs(platform.value);
  return result.list;
});
watch(tabs, (items) => {
  if (!items?.some((item) => item.id === tab_id.value)) tab_id.value = items?.[0]?.id || "";
});

// 参数变化
onBeforeRouteUpdate((to) => {
  if (to.name !== "new-album") return;
  tab_id.value = to.query.tab_id as string;
});

watch(
  () => platformStore.platforms,
  (platforms) => {
    if (!platforms.length) return;
    if (!platforms.some((item) => item.id === platform.value)) {
      platform.value = platforms[0].id;
    }
    void getTabList();
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
.new-song {
  display: flex;
  flex-direction: column;
  width: 100%;
  overflow: hidden;
  .tabs {
    width: 100%;
    overflow: hidden;
    :deep(.n-tabs-pane-wrapper) {
      overflow: hidden;
    }
  }
}
</style>
