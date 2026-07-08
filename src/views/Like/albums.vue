<template>
  <div class="like-type">
    <AlbumList :data="dataStore.userLikeData.albums" />
  </div>
</template>

<script setup lang="ts">
import { useDataStore } from "@/stores";
import AlbumList from "@/components/List/AlbumList.vue";

const dataStore = useDataStore();
</script>
