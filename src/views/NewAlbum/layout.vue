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
import { usePlatformTabs } from "@/composables/usePlatformTabs";
import NewAlbumResult from "@/views/NewAlbum/NewAlbumResult.vue";
import { newAlbumTabs } from "@/api/album";

const { tab_id, tabs, loading, failed, retry, tagChange } = usePlatformTabs(
  "new-album",
  newAlbumTabs,
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
