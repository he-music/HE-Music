<template>
  <n-slider
    v-model:value="sliderProgress"
    :step="0.01"
    :min="0"
    :max="statusStore.duration"
    :keyboard="false"
    :format-tooltip="formatTooltip"
    :tooltip="showTooltip"
    :show-tooltip="showSliderTooltip"
    :class="['player-slider', { drag: isDragging }]"
    @mouseenter="showSliderTooltip = true"
    @mouseleave="showSliderTooltip = false"
    @dragstart="startDrag"
    @dragend="endDrag"
  />
</template>

<script setup lang="ts">
import { useStatusStore } from "@/stores";
import { msToTime } from "@/utils/time";
import { usePlayer } from "@/utils/player";

withDefaults(defineProps<{ showTooltip?: boolean }>(), { showTooltip: true });

const player = usePlayer();
const statusStore = useStatusStore();

// 拖动时的临时值
const dragValue = ref(0);
// 是否拖动
const isDragging = ref(false);
// 是否显示提示
const showSliderTooltip = ref(false);

// 实时进度
const sliderProgress = computed({
  // 获取进度
  get: () => (isDragging.value ? dragValue.value : statusStore.currentTime),
  // 设置进度
  set: (value) => {
    // 若为拖动中
    if (isDragging.value) {
      dragValue.value = value;
      return;
    }
    // 结束或者为点击
    useThrottleFn((value: number) => {
      player.setSeek(value);
    }, 30);
  },
});

// 开始拖拽
const startDrag = () => {
  isDragging.value = true;
  // 立即赋值当前时间
  dragValue.value = statusStore.currentTime;
};

// 结束拖拽
const endDrag = () => {
  isDragging.value = false;
  // 直接更改进度
  player.setSeek(dragValue.value);
};

// 格式化提示
const formatTooltip = (value: number) => {
  return `${msToTime(value)} / ${msToTime(statusStore.duration)}`;
};
</script>

<style scoped lang="scss">
.player-slider {
  width: 100%;
  &:not(.drag) {
    :deep(.n-slider-rail) {
      .n-slider-rail__fill {
        transition: width 0.3s;
      }
      .n-slider-handle-wrapper {
        will-change: left;
        transition: left 0.3s;
      }
    }
  }
  :deep(.n-slider-handles) {
    .n-slider-handle {
      opacity: 0;
      transform: scale(0.6);
    }
  }
  &:hover,
  &.drag {
    :deep(.n-slider-handles) {
      .n-slider-handle {
        opacity: 1;
        transform: scale(1);
      }
    }
  }
}
</style>
