<template>
  <span ref="container" class="local-artwork">
    <img v-if="url" :src="url" :alt="alt" />
    <slot v-else />
  </span>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from "vue";
import { useElementVisibility } from "@vueuse/core";
import type { SongInfo } from "@/types/main.hemusic";
import { useLocalArtwork } from "@/composables/useLocalArtwork";

const props = withDefaults(defineProps<{ song: SongInfo; enabled?: boolean; alt?: string }>(), {
  enabled: true,
  alt: "",
});
const container = ref<HTMLElement>();
const visible = useElementVisibility(container);
const enabled = computed(() => props.enabled && visible.value);
const { url } = useLocalArtwork(toRef(props, "song"), enabled);
</script>

<style scoped>
.local-artwork {
  display: inline-block;
}
.local-artwork img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
