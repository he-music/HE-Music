<template>
  <img :src="logo" alt="HEMusic" :style="{ width: `${size}px`, height: `${size}px` }" />
</template>

<script setup lang="ts">
import logo from "@/assets/icons/HEMusic.svg";

defineProps({
  size: {
    type: Number,
    default: 36,
  },
});
</script>
