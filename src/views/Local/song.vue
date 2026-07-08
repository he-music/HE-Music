<template>
  <div class="local-songs">
    <SongList
      :key="data?.length"
      :data="data"
      :loading="loading"
      :hidden-cover="!settingStore.showLocalCover"
      :hidden-size="false"
    />
  </div>
</template>

<script setup lang="ts">
import { useSettingStore } from "@/stores";
import type { SongInfo } from "@/types/main.hemusic";

const settingStore = useSettingStore();

defineProps<{
  data: SongInfo[];
  loading: boolean;
}>();
</script>
