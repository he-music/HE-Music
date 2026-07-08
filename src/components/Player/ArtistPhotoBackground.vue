<template>
  <div
    class="photo-background"
    v-if="musicStore.artistPhoto.urls && musicStore.artistPhoto.urls.length > 0"
  >
    <!--    <div class="overlay"></div>-->
    <n-carousel
      autoplay
      effect="fade"
      :interval="15000"
      :show-dots="false"
      class="carousel"
      loop
      v-model:current-index="currentIndex"
    >
      <div v-for="img in musicStore.artistPhoto.urls" :key="img" class="carousel-item">
        <div class="background-image" :style="{ backgroundImage: `url(${img})` }"></div>
      </div>
    </n-carousel>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, onMounted } from "vue";
import { useMusicStore } from "@/stores";

const musicStore = useMusicStore();

const currentIndex = computed({
  get: () => musicStore.artistPhoto.index,
  set: (val) => {
    musicStore.artistPhoto.index = val;
  },
});

const fetchImages = () => {
  const song = musicStore.playSong;
  if (!song) return;
  const artists = song.artists;
  const platform = song.platform;
  let ids: string[] = [];
  let names: string[] = [];

  if (Array.isArray(artists)) {
    ids = artists.map((artist) => artist.id);
    names = artists.map((artist) => artist.name);
  } else if (typeof artists === "string") {
    names = artists
      .split("/")
      .map((name) => name.trim())
      .filter((name) => !!name);
  }

  if (names.length > 0) {
    musicStore.fetchArtistPictures(platform, ids, names);
  }
};

watch(
  () => musicStore.playSong.artists,
  () => {
    fetchImages();
  },
);

onMounted(() => {
  fetchImages();
});
</script>

<style scoped>
.photo-background {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
}

.carousel,
.carousel-item {
  width: 100%;
  height: 100%;
}

.background-image {
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  transform: scale(1.1);
}
</style>
