<template>
  <PageReleaseTabs
    route-name="new-album"
    :required-flags="requiredFlags"
    :fetch-tabs="newAlbumTabs"
  >
    <template #default="{ platform, tabId }">
      <NewAlbumResult :platform="platform" :tab_id="tabId" />
    </template>
    <template #skeleton>
      <AlbumList :data="[]" :loading-num="18" loading />
    </template>
  </PageReleaseTabs>
</template>

<script setup lang="ts">
import { newAlbumTabs } from "@/api/album";
import { FeatureSupportFlag } from "@/api/platform";
import AlbumList from "@/components/List/AlbumList.vue";
import PageReleaseTabs from "@/components/Page/PageReleaseTabs.vue";
import NewAlbumResult from "./NewAlbumResult.vue";

const requiredFlags = FeatureSupportFlag.GetNewAlbumTabList | FeatureSupportFlag.GetNewAlbumList;
</script>
