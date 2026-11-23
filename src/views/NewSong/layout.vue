<template>
  <PageReleaseTabs route-name="new-song" :required-flags="requiredFlags" :fetch-tabs="newSongTabs">
    <template #default="{ platform, tabId }">
      <NewSongResult :platform="platform" :tab_id="tabId" />
    </template>
    <template #skeleton>
      <NewSongSkeleton />
    </template>
  </PageReleaseTabs>
</template>

<script setup lang="ts">
import { FeatureSupportFlag } from "@/api/platform";
import { newSongTabs } from "@/api/song";
import PageReleaseTabs from "@/components/Page/PageReleaseTabs.vue";
import NewSongResult from "./NewSongResult.vue";
import NewSongSkeleton from "./NewSongSkeleton.vue";

const requiredFlags = FeatureSupportFlag.GetNewSongTabList | FeatureSupportFlag.GetNewSongList;
</script>
