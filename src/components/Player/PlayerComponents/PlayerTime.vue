<template>
  <span>{{ formattedTime }}</span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useStatusStore } from "@/stores/status";
import { msToTime } from "@/utils/time";

const props = withDefaults(defineProps<{ duration?: boolean }>(), { duration: false });
const statusStore = useStatusStore();
// 相同秒内返回相同字符串，避免毫秒变化触发时间组件及其父级重新渲染。
const formattedTime = computed(() =>
  msToTime(props.duration ? statusStore.duration : statusStore.currentTime),
);
</script>
