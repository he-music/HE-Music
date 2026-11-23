<template>
  <div class="scroll-viewport" :class="{ 'scroll-viewport--loading': loading }">
    <n-scrollbar :id="scrollId" ref="scrollbar" class="page-platform-scroll">
      <slot />
      <n-back-top
        v-if="!loading"
        :to="`#${scrollId}`"
        :right="isSmallScreen ? 16 : 40"
        :bottom="isSmallScreen ? 176 : 120"
      >
        <SvgIcon :size="22" name="Up" />
      </n-back-top>
    </n-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { useMobile } from "@/composables/useMobile";
import type { ScrollbarInst } from "naive-ui";

const props = defineProps<{ resetKey?: string; loading?: boolean }>();
const { isSmallScreen } = useMobile();
const scrollId = `platform-scroll-${useId()}`;
const scrollbar = ref<ScrollbarInst | null>(null);

watch(
  () => props.resetKey,
  () => scrollbar.value?.scrollTo({ top: 0 }),
  { flush: "post" },
);
</script>

<style scoped>
.scroll-viewport {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.scroll-viewport--loading :deep(.page-platform-scroll > .n-scrollbar-container) {
  overflow: hidden;
}

.scroll-viewport--loading :deep(.page-platform-scroll > .n-scrollbar-rail) {
  display: none;
}
</style>
