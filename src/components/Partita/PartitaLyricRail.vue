<template>
  <div
    ref="railRef"
    :class="['partita-rail', { pure, 'no-word-animation': !wordAnimation }]"
    :style="{
      '--partita-active-color': resolvedActiveColor,
      '--partita-font-size': `${resolvedFontSize}px`,
      '--partita-tran-size': `${translationSize}px`,
      '--partita-roma-size': `${romanizationSize}px`,
    }"
  >
    <!-- 1. 中央主舞台：占视口约 70% 高度，纯粹呈现云阶阶梯错落与引导线 -->
    <div :class="['partita-stage-container', { pure }]">
      <Transition name="partita-line" mode="out-in">
        <!-- 活跃歌词展示 -->
        <div
          v-if="currentLayout && activeLine"
          :key="activeLine.key"
          class="partita-line-wrapper"
          @click="onLineClick(activeLine.startTime)"
        >
          <!-- 阶梯 Chunks 渲染 -->
          <div
            v-for="chunk in currentLayout.chunks"
            :key="chunk.id"
            :class="[
              'partita-chunk',
              `guide-${chunk.guidePosition}`,
              `status-${getChunkStatus(chunk)}`,
            ]"
            :style="getChunkStyle(chunk)"
          >
            <!-- 阶梯标尺引导线 -->
            <template v-if="showGuideLines">
              <span class="partita-guide-v" aria-hidden="true" />
              <span class="partita-guide-h" aria-hidden="true" />
            </template>

            <!-- Chunk 内的展示词 -->
            <span
              v-for="(word, wordIdx) in chunk.displayWords"
              :key="`${word.text}-${wordIdx}`"
              :class="['partita-word-wrap', `word-${getWordStatus(word, chunk)}`]"
              @click.stop="onWordClick(word.startTime)"
            >
              <!-- 底层光晕发光层 -->
              <span class="partita-glow" aria-hidden="true">
                <template v-if="wordAnimation && word.text.length > 1">
                  <span
                    v-for="(char, cIdx) in getWordChars(word)"
                    :key="cIdx"
                    :class="['grapheme-char', { 'char-active': isCharActive(word, cIdx) }]"
                  >
                    {{ char }}
                  </span>
                </template>
                <template v-else>
                  {{ word.text }}
                </template>
              </span>

              <!-- 上层实体文字 -->
              <span class="partita-body">{{ word.text }}</span>

              <!-- 副歌水波纹扩散 -->
              <span
                v-if="activeLine.isChorus && getWordStatus(word) === 'active'"
                class="partita-ripple"
                aria-hidden="true"
              />
            </span>
          </div>
        </div>

        <!-- 间奏预备状态（若当前空闲但有下一句） -->
        <div
          v-else-if="upcomingLine && upcomingLine.fullText"
          :key="`preheat-${upcomingLine.key}`"
          class="partita-line-wrapper preheat-wrapper"
          @click="onLineClick(upcomingLine.startTime)"
        >
          <div class="preheat-line">
            <span class="preheat-text">{{ upcomingLine.fullText }}</span>
          </div>
        </div>

        <!-- 空状态或等待音乐 -->
        <div v-else class="partita-empty">
          <span>{{ emptyText }}</span>
        </div>
      </Transition>
    </div>

    <!-- 2. 独立底部图层（移植自 Folia VisualizerSubtitleOverlay）：固定在视口底部，展示翻译字幕或下一句预告 -->
    <Transition name="partita-bottom-fade">
      <div
        v-if="bottomOverlayContent"
        class="partita-bottom-overlay"
        @click="
          bottomOverlayContent.seekTime !== undefined && onLineClick(bottomOverlayContent.seekTime)
        "
      >
        <div class="bottom-glow-bg" aria-hidden="true" />
        <div class="bottom-content">
          <div v-if="bottomOverlayContent.type === 'translation'" class="bottom-translation">
            {{ bottomOverlayContent.text }}
          </div>
          <div v-else-if="bottomOverlayContent.type === 'upcoming'" class="bottom-upcoming">
            <span class="upcoming-badge">NEXT</span>
            <span class="upcoming-text">{{ bottomOverlayContent.text }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, type CSSProperties, type Ref, shallowRef } from "vue";
import { useElementSize } from "@vueuse/core";
import type { PartitaLine, WordPlayStatus } from "./model";
import { resolvePartitaFrame } from "./model";
import {
  getOrBuildPartitaLayout,
  type PartitaChunkData,
  type PartitaSequentialLayout,
} from "./layout";
import type { PartitaWordToken } from "./cjkSemanticLayout";
import "./partita.scss";

// Vue 移植版 Folia Partita (云阶) 歌词轨道组件
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
    color?: string; // 格式如 "255, 255, 255" 或 "#ffffff"
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
    staggerMin: 20,
    staggerMax: 54,
    color: "255, 255, 255",
    emptyText: "等待音乐响起...",
    pure: false,
  },
);

const emit = defineEmits<{
  (e: "seek", time: number): void;
}>();

const railRef = shallowRef<HTMLElement | null>(null);
const { height: containerHeight, width: containerWidth } = useElementSize(railRef);

const resolvedActiveColor = computed(() => {
  if (!props.color) return "#ffffff";
  if (props.color.startsWith("#") || props.color.startsWith("rgb")) {
    return props.color;
  }
  return `rgb(${props.color})`;
});

// 当前时间（毫秒）
const currentTime = computed(() => props.clock.time.value);

// 解析当前活跃行
const currentFrame = computed(() => resolvePartitaFrame(props.lines, currentTime.value));
const activeLine = computed(() => currentFrame.value.activeLine);
const upcomingLine = computed(() => currentFrame.value.upcomingLine);

// 底部独立字幕层内容（Folia 契约：有翻译显示翻译，无翻译显示下一句预告）
const bottomOverlayContent = computed<{
  type: "translation" | "upcoming";
  text: string;
  seekTime?: number;
} | null>(() => {
  if (props.showTranslation && activeLine.value?.translation?.trim()) {
    return {
      type: "translation",
      text: activeLine.value.translation,
      seekTime: activeLine.value.startTime,
    };
  }
  if (props.showUpcoming && upcomingLine.value?.fullText?.trim()) {
    return {
      type: "upcoming",
      text: upcomingLine.value.fullText,
      seekTime: upcomingLine.value.startTime,
    };
  }
  return null;
});

// 自适应字号：根据纯歌词模式与短句动态适度缩放，使短句更饱满大气
const resolvedFontSize = computed(() => {
  let size = props.fontSize;
  if (props.pure) {
    size *= 1.18;
  }
  if (activeLine.value) {
    const textLen = activeLine.value.fullText.trim().length;
    if (textLen > 0 && textLen <= 6) {
      size *= 1.25;
    } else if (textLen <= 10) {
      size *= 1.14;
    }
  }
  return Math.round(size);
});

// 当前活跃行的排版数据（带缓存）
const currentLayout = computed<PartitaSequentialLayout | null>(() => {
  if (!activeLine.value) return null;
  // 依据可用宽度对错位位移自适应拉伸
  const widthFactor = Math.min(1.5, Math.max(0.9, (containerWidth.value || 600) / 550));
  return getOrBuildPartitaLayout(activeLine.value, containerHeight.value || 500, {
    showGuideLines: props.showGuideLines,
    useSemanticLayout: true,
    staggerMin: Math.round(props.staggerMin * widthFactor),
    staggerMax: Math.round(props.staggerMax * widthFactor),
  });
});

// 计算 Chunk 状态
function getChunkStatus(chunk: PartitaChunkData): WordPlayStatus {
  const time = currentTime.value;
  if (!chunk.chunkWords || chunk.chunkWords.length === 0) return "waiting";
  const start = chunk.chunkWords[0].startTime;
  const end = chunk.chunkWords[chunk.chunkWords.length - 1].endTime;

  if (time < start - 150) return "waiting";
  if (time > end) return "passed";
  return "active";
}

// 动态计算 Chunk 阶梯登场几何与弹簧位移（移植自 Folia 原版：waiting 状态向外偏置 40px，scale 0.85）
function getChunkStyle(chunk: PartitaChunkData): CSSProperties {
  const status = getChunkStatus(chunk);
  const isLeft = chunk.guidePosition === "left";
  const offsetX = status === "waiting" ? chunk.config.x + (isLeft ? -40 : 40) : chunk.config.x;
  const scale = status === "waiting" ? 0.85 : 1;
  const rotate =
    status === "passed" ? chunk.config.rotate + chunk.config.passedRotate : chunk.config.rotate;

  return {
    transform: `translate3d(${offsetX}px, 0, 0) scale(${scale}) rotate(${rotate}deg)`,
    marginBottom: `${chunk.config.marginBottom}px`,
  };
}

// 计算 Word 状态
function getWordStatus(word: PartitaWordToken, chunk?: PartitaChunkData): WordPlayStatus {
  if (props.wordAnimation === false && chunk) {
    return getChunkStatus(chunk);
  }
  const time = currentTime.value;
  if (time < word.startTime - 120) return "waiting";
  if (time > word.endTime) return "passed";
  return "active";
}

// 提取词的字符数组
function getWordChars(word: PartitaWordToken): string[] {
  return Array.from(word.text);
}

// 检查某个字符是否正处于扫光高亮时间段
function isCharActive(word: PartitaWordToken, charIndex: number): boolean {
  const time = currentTime.value;
  const chars = getWordChars(word);
  if (chars.length <= 1) return getWordStatus(word) === "active";

  const duration = Math.max(word.endTime - word.startTime, 50);
  const charDuration = duration / chars.length;
  const charStart = word.startTime + charDuration * charIndex;
  const charEnd = charStart + charDuration;

  return time >= charStart && time <= charEnd;
}

// 点击跳转
function onLineClick(time: number) {
  emit("seek", time);
}

function onWordClick(time: number) {
  emit("seek", time);
}
</script>
