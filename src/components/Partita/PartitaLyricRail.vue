<template>
  <GlowStage
    mode="partita"
    :lines="stageLines"
    :clock="clock"
    :playing="playing"
    :word-animation="wordAnimation"
    :font-size="fontSize"
    :translation-size="translationSize"
    :romanization-size="romanizationSize"
    :show-translation="showTranslation"
    :show-romanization="showRomanization"
    :show-guide-lines="showGuideLines"
    :show-upcoming="showUpcoming"
    :stagger-min="staggerMin"
    :stagger-max="staggerMax"
    :color="color"
    :empty-text="emptyText"
    @seek="emit('seek', $event)"
  />
</template>
<script setup lang="ts">
import { computed, type Ref } from "vue";
import type { PartitaLine } from "./model";
import GlowStage from "@/components/LyricDom/GlowStage.vue";
import { toStageLine } from "@/components/LyricDom/model";

// 云阶保留播放器与预览接口，构图和逐词动画由固定版本的 Folia 算法驱动。
const props = withDefaults(
  defineProps<{
    lines: PartitaLine[];
    clock: { time: Readonly<Ref<number>> };
    playing?: boolean;
    wordAnimation?: boolean;
    fontSize?: number;
    translationSize?: number;
    romanizationSize?: number;
    showTranslation?: boolean;
    showRomanization?: boolean;
    showGuideLines?: boolean;
    showUpcoming?: boolean;
    staggerMin?: number;
    staggerMax?: number;
    color?: string;
    emptyText?: string;
    pure?: boolean;
  }>(),
  {
    playing: true,
    wordAnimation: true,
    fontSize: 44,
    translationSize: 18,
    romanizationSize: 15,
    showTranslation: true,
    showRomanization: true,
    showGuideLines: true,
    showUpcoming: true,
    staggerMin: 12,
    staggerMax: 36,
    color: "255, 255, 255",
    emptyText: "",
    pure: false,
  },
);
const emit = defineEmits<{ seek: [time: number] }>();
const stageLines = computed(() => props.lines.map(toStageLine));
</script>
