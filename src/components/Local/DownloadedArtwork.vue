<template>
  <span class="downloaded-artwork">
    <LocalArtworkImage v-if="song" :song="song" class="image">
      <s-image :src="fallback || '/images/song.jpg?asset'" class="image" />
    </LocalArtworkImage>
    <s-image v-else :src="fallback || '/images/song.jpg?asset'" class="image" />
  </span>
</template>

<script setup lang="ts">
import type { SongInfo } from "@/types/main.hemusic";
import LocalArtworkImage from "./LocalArtworkImage.vue";

defineProps<{ song?: SongInfo; fallback?: string }>();
</script>

<style scoped>
.downloaded-artwork,
.image {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
