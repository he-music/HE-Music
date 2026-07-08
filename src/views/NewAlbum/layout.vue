<template>
  <div class="new-song">
    <n-tabs v-model:value="tab_id" class="tabs" type="bar" animated @update:value="tagChange">
      <n-tab-pane
        v-for="tab in tabs"
        :key="`new-song-${tab.platform}-${tab.id}`"
        :name="tab.id"
        :tab="tab.name"
        display-directive="show:lazy"
      >
        <NewAlbumResult :platform="tab.platform" :tab_id="tab_id" />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
import type { TabInfo } from "@/types/main.hemusic";

import { usePlatformStore } from "@/stores";
import NewAlbumResult from "@/views/NewAlbum/NewAlbumResult.vue";
import { onMounted } from "vue";
import { newAlbumTabs } from "@/api/album";

const router = useRouter();
const platformStore = usePlatformStore();

const tabs = ref<TabInfo[]>([]);
const tab_id = ref<string>(router.currentRoute.value.query?.tab_id as string);
const platform = ref<string>(router.currentRoute.value.query?.platform as string);
if (!platformStore.platforms.find((p) => p.id === platform.value)) {
  platform.value = platformStore.platforms[0].id;
}

const tagChange = (tab_id: string) => {
  router.replace({
    name: "new-album",
    query: {
      tab_id: tab_id,
      platform: platform.value,
    },
  });
};
const getTabList = async () => {
  const result = await newAlbumTabs(platform.value);
  const tab = result.list.find((item) => item.id === tab_id.value);
  if (!tab) {
    tab_id.value = result.list[0].id;
  }
  tabs.value = result.list;
};

// 参数变化
onBeforeRouteUpdate((to) => {
  if (to.name !== "new-album") return;
  tab_id.value = to.query.tab_id as string;
});

onMounted(() => {
  getTabList();
});
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
