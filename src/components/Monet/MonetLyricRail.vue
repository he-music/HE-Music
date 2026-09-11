<template>
  <div
    ref="rail"
    class="monet-rail"
    :class="{ 'monet-reduced-motion': reducedMotion }"
    :style="railStyle"
    @wheel="browse.wheel"
    @touchmove="browse.touchMove"
    @pointerdown="browse.pointerDown"
    @pointermove="browse.pointerMove"
    @pointerup="browse.pointerEnd"
    @pointercancel="browse.pointerEnd"
    @pointerleave="browse.leave"
    @mouseenter="browse.enter(hoverPause)"
  >
    <div v-if="loading || !lines.length" class="monet-empty" role="status">{{ emptyText }}</div>
    <template v-else>
      <div
        v-for="entry in entries"
        :key="entry.line.key"
        :ref="(node) => setLineNode(entry.line.key, node)"
        class="monet-line"
        :class="[entry.status, { duet: entry.line.duet, background: entry.line.background }]"
        :style="toneStyle(entry)"
        role="button"
        tabindex="0"
        :aria-label="`${seekLabel}: ${entry.line.text}`"
        :aria-current="entry.status === 'active' ? 'true' : undefined"
        @click.stop="seek(entry.line.start)"
        @keydown.enter.prevent.stop="seek(entry.line.start)"
        @keydown.space.prevent.stop="seek(entry.line.start)"
      >
        <div class="monet-text" :lang="getLyricLanguage(entry.line.text)">
          <template v-if="entry.line.timed">
            <span v-for="(word, wi) in entry.line.words" :key="wi" class="monet-word"
              ><span
                v-for="(glyph, gi) in word.glyphs"
                :key="gi"
                class="monet-glyph"
                :data-glyph-start="glyph.start"
                :data-glyph-end="glyph.end"
                :data-text="glyph.text"
                >{{ glyph.text }}</span
              ></span
            >
          </template>
          <template v-else>{{ entry.line.text }}</template>
        </div>
        <template v-if="entry.status === 'active' || browse.manualAnchor.value !== null">
          <div v-if="showTranslation && entry.line.translation" class="monet-translation">
            {{ entry.line.translation }}
          </div>
          <div v-if="showRomanization && entry.line.romanization" class="monet-romanization">
            {{ entry.line.romanization }}
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch, type CSSProperties, type Ref } from "vue";
import {
  useDocumentVisibility,
  useElementVisibility,
  usePreferredReducedMotion,
} from "@vueuse/core";
import { getLyricLanguage } from "@/utils/lyric/language";
import { resolveMonetFrame, type MonetLine } from "./model";
import { resolveTone } from "./motion";
import { useMonetMotion, type RailEntry } from "./useMonetMotion";
import { useMonetBrowse } from "./useMonetBrowse";

// src/components/Monet/MonetLyricRail.vue
// Vue adaptation of Folia's MonetLyricsRail (chthollyphile, AGPL-3.0).
const props = withDefaults(
  defineProps<{
    lines: MonetLine[];
    clock: { time: Readonly<Ref<number>> };
    playing: boolean;
    loading?: boolean;
    fontSize?: number;
    translationSize?: number;
    romanizationSize?: number;
    alignPosition?: number;
    textAlign?: "left" | "center" | "right";
    color?: string;
    showTranslation?: boolean;
    showRomanization?: boolean;
    blur?: boolean;
    hoverPause?: boolean;
    emptyText?: string;
    seekLabel?: string;
  }>(),
  {
    fontSize: 46,
    translationSize: 22,
    romanizationSize: 18,
    alignPosition: 0.46,
    textAlign: "left",
    color: "239, 239, 239",
    showTranslation: true,
    showRomanization: true,
    blur: false,
    hoverPause: false,
    emptyText: "",
    seekLabel: "",
  },
);
const emit = defineEmits<{ seek: [time: number] }>();
const rail = ref<HTMLElement | null>(null);
const documentVisibility = useDocumentVisibility();
const elementVisible = useElementVisibility(rail);
const visible = computed(() => documentVisibility.value === "visible" && elementVisible.value);
const reducedPreference = usePreferredReducedMotion();
const reducedMotion = computed(() => reducedPreference.value === "reduce");
const running = computed(() => props.playing && !props.loading);
const timeline = shallowRef(resolveMonetFrame(props.lines, props.clock.time.value));
const anchor = computed(() => timeline.value.anchor);
const browse = useMonetBrowse(() => props.lines.length, anchor);
const boundaries = computed(() =>
  [...new Set(props.lines.flatMap((line) => [line.start, line.end]))].sort((a, b) => a - b),
);
let boundaryIndex = -1;

/** 只在越过行边界时更新 Vue 状态，字形扫光直接订阅时钟。 */
function updateTimeline(time: number, force = false) {
  const values = boundaries.value;
  let low = 0,
    high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] <= time) low = mid + 1;
    else high = mid;
  }
  if (force || low !== boundaryIndex) {
    boundaryIndex = low;
    timeline.value = resolveMonetFrame(props.lines, time);
  }
}
watch(props.clock.time, (time, previous) => {
  if (Math.abs(time - previous) > 500) browse.reset();
  if (visible.value) updateTimeline(time);
});
watch(
  () => props.lines,
  () => {
    browse.reset();
    updateTimeline(props.clock.time.value, true);
  },
  { immediate: true },
);
watch(visible, (shown) => {
  if (shown) updateTimeline(props.clock.time.value, true);
});
const entries = computed<RailEntry[]>(() => {
  if (props.loading) return [];
  const focus = browse.manualAnchor.value ?? anchor.value;
  const start = Math.max(0, focus - 4);
  return props.lines.slice(start, focus + 5).map((line, i) => ({
    line,
    index: start + i,
    offset: start + i - focus,
    status: timeline.value.statuses[start + i] ?? "waiting",
  }));
});
const { setLineNode, scheduleMeasure } = useMonetMotion({
  rail,
  entries,
  clock: props.clock,
  running,
  visible,
  reducedMotion,
  alignment: () => props.alignPosition,
  fontSize: () => props.fontSize,
});
watch(
  () => [
    props.alignPosition,
    props.textAlign,
    props.fontSize,
    props.translationSize,
    props.romanizationSize,
    props.showTranslation,
    props.showRomanization,
  ],
  scheduleMeasure,
  { flush: "post" },
);
const railStyle = computed(() => ({
  "--monet-color": props.color,
  "--monet-font-size": `${props.fontSize}px`,
  "--monet-translation-size": `${props.translationSize}px`,
  "--monet-romanization-size": `${props.romanizationSize}px`,
  "--monet-align": props.textAlign,
  "--monet-origin": `${props.textAlign} top`,
}));
function toneStyle(entry: RailEntry): CSSProperties {
  const tone = resolveTone(entry.status, entry.offset);
  return {
    opacity: tone.opacity,
    filter: props.blur && !reducedMotion.value ? `blur(${tone.blur}px)` : "none",
    zIndex: entry.status === "active" ? 2 : 1,
  };
}
function seek(time: number) {
  if (browse.allowClick()) emit("seek", time);
}
</script>

<style scoped lang="scss" src="./monet.scss"></style>
