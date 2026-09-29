<template>
  <SearchResultList :keyword="keyword" :platform="platform" type="playlist" />
</template>

<script setup lang="ts">
import SearchResultList from "@/components/Search/SearchResultList.vue";
defineProps<{ keyword: string; platform: string }>();
</script>
