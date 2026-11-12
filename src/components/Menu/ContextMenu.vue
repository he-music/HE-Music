<template>
  <n-dropdown
    v-bind="$attrs"
    :x="menuX"
    :y="menuY"
    :menu-props="menuProps"
    placement="bottom-start"
    trigger="manual"
    scrollable
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useWindowSize } from "@vueuse/core";
import { NDropdown, type DropdownMenuProps } from "naive-ui";

defineOptions({ inheritAttrs: false });
const props = defineProps<{ x: number; y: number }>();
const { width, height } = useWindowSize();
const edgeGap = 8;
const menuX = computed(() => Math.max(edgeGap, Math.min(props.x, width.value - edgeGap)));
const menuY = computed(() => Math.max(edgeGap, Math.min(props.y, height.value - edgeGap)));

const menuProps: DropdownMenuProps = (option) => ({
  // 主菜单需要放进鼠标上方或下方；子菜单预留半个窗口，保证翻转后仍能容纳。
  // 预留窗口边距以及菜单与触发点之间的间隔。
  style: `max-height: ${Math.max(
    0,
    (option ? height.value / 2 : Math.max(menuY.value, height.value - menuY.value)) - edgeGap * 2,
  )}px`,
});
</script>
