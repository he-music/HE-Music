<template>
  <div class="like-type">
    <ArtistList :data="dataStore.userLikeData.artists" />
  </div>
</template>

<script setup lang="ts">
import { useDataStore } from "@/stores";
import ArtistList from "@/components/List/ArtistList.vue";

const dataStore = useDataStore();
</script>
