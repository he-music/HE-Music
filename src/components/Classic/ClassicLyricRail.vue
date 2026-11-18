<template>
  <GlowStage
    mode="classic"
    :lines="stageLines"
    :clock="clock"
    :playing="playing"
    :loading="loading"
    :word-animation="wordAnimation"
    :font-size="fontSize"
    :translation-size="translationSize"
    :romanization-size="romanizationSize"
    :show-translation="showTranslation"
    :show-romanization="showRomanization"
    :show-upcoming="showUpcoming"
    :enable-word-rotation="enableWordRotation"
    :breathing="breathingFloatMultiplier"
    :word-spacing="wordSpacing"
    :color="accentColor || mainColor"
    :empty-text="emptyText"
    :seek-label="seekLabel"
    @seek="emit('seek', $event)"
  />
</template>
<script setup lang="ts">
import { computed, type Ref } from "vue";
import type { ClassicLine } from "./types";
import GlowStage from "@/components/LyricDom/GlowStage.vue";
import { toStageLine } from "@/components/LyricDom/model";

// 流光与云阶共用词级动画，保留现有播放器和设置预览的参数。
const props = withDefaults(
  defineProps<{
    lines: ClassicLine[];
    clock: { time: Readonly<Ref<number>> };
    playing?: boolean;
    loading?: boolean;
    wordAnimation?: boolean;
    fontSize?: number;
    translationSize?: number;
    romanizationSize?: number;
    mainColor?: string;
    accentColor?: string;
    showTranslation?: boolean;
    showRomanization?: boolean;
    showUpcoming?: boolean;
    enableWordRotation?: boolean;
    breathingFloatMultiplier?: number;
    wordSpacing?: number;
    emptyText?: string;
    seekLabel?: string;
  }>(),
  {
    playing: false,
    loading: false,
    wordAnimation: true,
    fontSize: 52,
    translationSize: 20,
    romanizationSize: 16,
    mainColor: "239, 239, 239",
    accentColor: "",
    showTranslation: true,
    showRomanization: true,
    showUpcoming: true,
    enableWordRotation: true,
    breathingFloatMultiplier: 1,
    wordSpacing: 0.7,
    emptyText: "",
    seekLabel: "",
  },
);
const emit = defineEmits<{ seek: [time: number] }>();
const stageLines = computed(() => props.lines.map(toStageLine));
</script>
