<template>
  <div
    ref="rootRef"
    class="classic-visualizer"
    :class="{ 'no-word-animation': !animateWords, 'word-sweep': animateWords }"
    :style="visualizerStyle"
    role="region"
    aria-label="Classic Lyrics Rail"
  >
    <!-- 主舞台区域（中央 70vh 区域） -->
    <div
      class="classic-stage-wrapper"
      :class="{ breathing: breathingFloatMultiplier > 0 && !reducedMotion }"
      :style="{ animationPlayState: playing ? 'running' : 'paused' }"
    >
      <Transition
        name="line"
        @before-enter="prepareLineEnter"
        @before-leave="prepareLineLeave"
        @leave-cancelled="restoreLineInteraction"
        @after-enter="refreshGlow"
      >
        <!-- 舞台主歌词行：只要有歌词就展示当前句（前奏/间奏期单词呈现静候态） -->
        <div
          v-if="!loading && activeLine"
          :key="activeLine.key"
          class="classic-line-container"
          :data-transition-mode="resolveClassicTransitionMode(activeLine)"
          :style="{
            justifyContent: lineConfig.justifyContent,
            alignItems: lineConfig.alignItems,
            perspective: `${lineConfig.perspective}px`,
          }"
          role="button"
          tabindex="0"
          :aria-label="`${seekLabel}: ${activeLine.text}`"
          @click="emit('seek', activeLine.startTime)"
          @keydown.enter.prevent="emit('seek', activeLine.startTime)"
          @keydown.space.prevent="emit('seek', activeLine.startTime)"
        >
          <div
            v-for="(word, wIdx) in activeLine.words"
            :key="`${word.text}-${wIdx}-${activeLine.key}`"
            class="classic-word"
            :class="`status-${wordStatuses[wIdx] || 'waiting'}`"
            :style="getWordStyle(wIdx)"
          >
            <!-- 发光层（双层 text-shadow） -->
            <span class="classic-word-glow" aria-hidden="true">
              <template v-if="animateWords">
                <span
                  v-for="(glyph, index) in word.graphemes"
                  :key="index"
                  data-stage-glyph
                  :data-start="glyph.startTime"
                  :data-end="glyph.endTime"
                  :data-line-end="activeLine.endTime"
                  style="opacity: 0"
                  >{{ glyph.char }}</span
                >
              </template>
              <template v-else>{{ word.text }}</template>
            </span>
            <!-- 文本主体 -->
            <span class="classic-word-body">{{ word.text }}</span>
            <!-- 副歌水波纹光环 -->
            <span
              v-if="
                activeLine.isChorus && wordStatuses[wIdx] === 'active' && animateWords && playing
              "
              class="classic-ripple"
              aria-hidden="true"
            />
          </div>
        </div>
        <!-- 真正无歌词或加载中 -->
        <div v-else class="classic-empty-text" role="status">
          {{ emptyText }}
        </div>
      </Transition>
    </div>

    <!-- 底部独立沉底图层（移植自 Folia VisualizerSubtitleOverlay：翻译字幕 / NEXT 下一句预告） -->
    <Transition name="classic-bottom-fade">
      <div
        v-if="bottomOverlayContent"
        class="classic-bottom-overlay"
        role="button"
        tabindex="0"
        :aria-label="`${seekLabel}: ${bottomOverlayContent.text || bottomOverlayContent.romanization}`"
        @click="
          bottomOverlayContent.seekTime !== undefined && emit('seek', bottomOverlayContent.seekTime)
        "
        @keydown.enter.prevent="
          bottomOverlayContent.seekTime !== undefined && emit('seek', bottomOverlayContent.seekTime)
        "
        @keydown.space.prevent="
          bottomOverlayContent.seekTime !== undefined && emit('seek', bottomOverlayContent.seekTime)
        "
      >
        <div class="bottom-content">
          <template v-if="bottomOverlayContent.type === 'translation'">
            <div v-if="bottomOverlayContent.text" class="bottom-translation">
              {{ bottomOverlayContent.text }}
            </div>
            <div v-if="bottomOverlayContent.romanization" class="bottom-romanization">
              {{ bottomOverlayContent.romanization }}
            </div>
          </template>
          <div v-else-if="bottomOverlayContent.type === 'upcoming'" class="bottom-upcoming">
            <p class="upcoming-text">{{ bottomOverlayContent.text }}</p>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch, type CSSProperties, type Ref } from "vue";
import { useElementSize, usePreferredReducedMotion } from "@vueuse/core";
import {
  resolveActiveLineIndex,
  resolveDeterministicWordLayouts,
  resolveWordStatus,
  resolveUpcomingLine,
} from "./model";
import type {
  ClassicLine,
  ClassicLineLayoutConfig,
  ClassicWordLayoutConfig,
  ClassicWordStatus,
} from "./types";
import { useStageClock } from "@/components/LyricStage/useStageClock";
import { useStageGlow } from "@/components/LyricStage/useStageGlow";
import { resolveClassicTransitionMode, resolveClassicEnterDuration } from "./transition";
import "./classic.scss";

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
    accentColor: "255, 255, 255",
    showTranslation: true,
    showRomanization: true,
    showUpcoming: true,
    enableWordRotation: true,
    breathingFloatMultiplier: 1.0,
    wordSpacing: 0.7,
    emptyText: "等待音乐响起...",
    seekLabel: "播放",
  },
);

const emit = defineEmits<{ seek: [time: number] }>();

const rootRef = ref<HTMLElement | null>(null);
const { width: containerWidth } = useElementSize(rootRef);
const reducedPreference = usePreferredReducedMotion();
const reducedMotion = computed(() => reducedPreference.value === "reduce");
const stageTime = useStageClock(() => props.lines, props.clock.time);
const refreshGlow = useStageGlow(rootRef, props.clock.time);
const animateWords = computed(
  () => props.wordAnimation && !!activeLine.value?.timed && !reducedMotion.value,
);

// 响应式自适应缩放因子（针对窄视口与移动端 360px ~ 760px 自适应缩放）
const widthScaleFactor = computed(() => {
  const w = containerWidth.value;
  if (!w || w >= 860) return 1.0;
  return Math.max(0.48, Math.min(1.0, w / 860));
});

const resolvedFontSize = computed(() => {
  const w = containerWidth.value || 800;
  const base = props.fontSize || 48;
  const scaled = Math.round(base * widthScaleFactor.value);

  // 防溢出保护：当前行字符较多且容器受限时，智能收敛字号，确保绝不撑爆屏幕两端
  const line = activeLine.value;
  if (!line) return scaled;
  const totalChars = line.text?.length || 0;
  if (totalChars > 6 && w < 960) {
    const maxCharsPerLine = Math.max(Math.ceil(totalChars / 2), 4);
    const maxSafeSize = Math.max(22, Math.floor((w - 32) / (maxCharsPerLine * 1.52)));
    return Math.min(scaled, maxSafeSize);
  }
  return scaled;
});

const resolvedTranSize = computed(() => {
  return Math.round(props.translationSize * Math.max(0.72, widthScaleFactor.value));
});

const resolvedRomaSize = computed(() => {
  return Math.round(props.romanizationSize * Math.max(0.75, widthScaleFactor.value));
});

// 当前活跃行索引
const activeIndex = shallowRef(0);

// 活跃行计算：未进入唱词或等待音乐响起时返回 null，展示 emptyText
const activeLine = computed<ClassicLine | null>(() => {
  if (!props.lines.length) return null;
  const idx = activeIndex.value;
  if (idx >= 0 && idx < props.lines.length) {
    return props.lines[idx];
  }
  return null;
});

// 下一句待播放的歌词
const upcomingLine = computed(() =>
  resolveUpcomingLine(props.lines, activeIndex.value, stageTime.value),
);

// 底部沉底图层内容（优先展示活跃行翻译，唱完或间奏时展示下一句预告）
const bottomOverlayContent = computed<{
  type: "translation" | "upcoming";
  text: string;
  romanization?: string;
  seekTime?: number;
} | null>(() => {
  if (props.loading) return null;
  const translation = props.showTranslation ? activeLine.value?.translation?.trim() : "";
  const romanization = props.showRomanization ? activeLine.value?.romanization?.trim() : "";
  if (translation || romanization) {
    return {
      type: "translation",
      text: translation || "",
      romanization,
      seekTime: activeLine.value?.startTime,
    };
  }
  if (props.showUpcoming && upcomingLine.value?.text?.trim()) {
    return {
      type: "upcoming",
      text: upcomingLine.value.text,
      seekTime: upcomingLine.value.startTime,
    };
  }
  return null;
});

// 单词布局配置与容器配置
const wordConfigs = shallowRef<ClassicWordLayoutConfig[]>([]);
const lineConfig = shallowRef<ClassicLineLayoutConfig>({
  justifyContent: "center",
  alignItems: "center",
  perspective: 1000,
});

// 当前活跃行各词的 waiting / active / passed 状态
const wordStatuses = ref<ClassicWordStatus[]>([]);

// 监听活跃行与容器宽度变化，重新计算确定性几何与自适应布局
watch(
  [activeLine, containerWidth, () => props.enableWordRotation, () => props.wordSpacing],
  ([line, w]) => {
    if (!line) {
      wordConfigs.value = [];
      wordStatuses.value = [];
      return;
    }
    const result = resolveDeterministicWordLayouts(
      line,
      {
        enableWordRotation: props.enableWordRotation,
        wordSpacing: props.wordSpacing,
      },
      { containerWidth: w },
    );
    wordConfigs.value = result.wordConfigs;
    lineConfig.value = result.lineConfig;
    updateWordStatuses(props.clock.time.value);
  },
  { immediate: true },
);

function updateWordStatuses(time: number) {
  const line = activeLine.value;
  if (!line || !line.words.length) {
    wordStatuses.value = [];
    return;
  }
  const nextStatuses: ClassicWordStatus[] = !animateWords.value
    ? line.words.map(() =>
        time < line.startTime ? "waiting" : time > line.endTime ? "passed" : "active",
      )
    : line.words.map((word) => resolveWordStatus(word, time));
  if (
    nextStatuses.length !== wordStatuses.value.length ||
    nextStatuses.some((status, index) => status !== wordStatuses.value[index])
  ) {
    wordStatuses.value = nextStatuses;
  }
}

function syncTime(time: number) {
  const nextIdx = resolveActiveLineIndex(props.lines, time);
  if (nextIdx !== activeIndex.value) {
    activeIndex.value = nextIdx;
  }
  updateWordStatuses(time);
}

// 订阅时钟与歌词列表变更，立即同步
watch(stageTime, (time) => syncTime(time), { immediate: true });
watch(animateWords, () => updateWordStatuses(props.clock.time.value));
watch(
  () => props.lines,
  () => syncTime(props.clock.time.value),
  { immediate: true },
);

// 新旧行在同一网格中并行过渡；离场行只保留视觉，不再响应跳转。
function restoreLineInteraction(element: Element) {
  (element as HTMLElement).inert = false;
  element.removeAttribute("aria-hidden");
}

function prepareLineEnter(element: Element) {
  restoreLineInteraction(element);
  const line = activeLine.value;
  const duration = line ? resolveClassicEnterDuration(line, props.clock.time.value) : 0;
  (element as HTMLElement).style.setProperty("--line-enter-duration", `${duration}ms`);
  element.toggleAttribute("data-skip-enter", duration === 0);
}

function prepareLineLeave(element: Element) {
  (element as HTMLElement).inert = true;
  element.setAttribute("aria-hidden", "true");
}

function getWordStyle(wIdx: number): CSSProperties {
  const cfg = wordConfigs.value[wIdx];
  if (!cfg) return {};
  const waitingX = Math.round(cfg.x + Math.sin(cfg.y) * 100);
  const waitingY = Math.round(cfg.y + Math.cos(cfg.x) * 50);
  return {
    "--word-x": `${cfg.x}px`,
    "--word-y": `${cfg.y}px`,
    "--word-waiting-x": `${waitingX}px`,
    "--word-waiting-y": `${waitingY}px`,
    "--word-rotate": `${cfg.rotate}deg`,
    "--word-scale": `${cfg.scale}`,
    "--word-passed-rotate": `${cfg.passedRotate}deg`,
    "--word-waiting-rotate": `${props.enableWordRotation ? cfg.rotate + 20 : 0}deg`,
    marginRight: cfg.marginRight,
  } as CSSProperties;
}

const visualizerStyle = computed(() => ({
  "--classic-main-color": props.mainColor,
  "--classic-accent-color": props.accentColor,
  "--classic-font-size": `${resolvedFontSize.value}px`,
  "--classic-tran-size": `${resolvedTranSize.value}px`,
  "--classic-roma-size": `${resolvedRomaSize.value}px`,
  "--classic-breathing": props.breathingFloatMultiplier,
}));
</script>
