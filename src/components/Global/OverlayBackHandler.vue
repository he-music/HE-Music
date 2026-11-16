<template>
  <slot />
</template>

<script setup lang="ts">
import { useOverlayBack } from "@/composables/useOverlayBack";

const props = defineProps<{
  overlay: { show?: boolean; destroy: () => void };
}>();

useOverlayBack(
  () => props.overlay.show !== false,
  () => props.overlay.destroy(),
);
</script>
