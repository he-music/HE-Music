<template>
  <div class="download-downloaded">
    <SongList :data="data" :loading="loading" />
  </div>
</template>

<script setup lang="ts">
import SongList from "@/components/List/SongList.vue";
import type { SongInfo } from "@/types/main.hemusic";

defineProps<{
  data: SongInfo[];
  loading: boolean;
}>();
</script>

<style lang="scss" scoped>
.download-downloaded {
  height: 100%;
}
</style>
