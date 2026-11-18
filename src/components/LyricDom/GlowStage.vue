<template>
  <div
    ref="root"
    class="dom-stage"
    :class="[`dom-${mode}`, { 'dom-reduced': reduced }]"
    :style="stageStyle"
  >
    <div ref="viewport" class="dom-stage-viewport">
      <div class="dom-float" :class="{ breathing: breathing > 0 && !reduced }">
        <div class="dom-fit" :style="{ transform: `scale(${fit})` }">
          <Transition name="dom-line" @before-enter="prepareEnter" @before-leave="prepareLeave">
            <div
              v-if="activeLine && !loading"
              :key="activeLine.key"
              ref="content"
              class="dom-line"
              :lang="getLyricLanguage(activeLine.fullText)"
              :data-transition="profile?.lineTransitionMode"
              :style="lineStyle"
              role="button"
              tabindex="0"
              :aria-label="`${seekLabel}: ${activeLine.fullText}`"
              @click="emit('seek', activeLine.startTime * 1000)"
              @keydown.enter.prevent="emit('seek', activeLine.startTime * 1000)"
              @keydown.space.prevent="emit('seek', activeLine.startTime * 1000)"
            >
              <div
                v-for="row in layout.rows"
                :key="row.key"
                class="dom-row"
                :class="{ 'dom-chunk': mode === 'partita' }"
                :data-motion-index="row.motionIndex"
                :data-guide="row.guide"
                :dir="row.direction"
                :style="row.style"
              >
                <template v-if="mode === 'partita' && showGuideLines">
                  <span class="dom-guide-v" aria-hidden="true" />
                  <span class="dom-guide-h" aria-hidden="true" />
                </template>
                <span
                  v-for="entry in row.words"
                  :key="entry.key"
                  class="dom-word"
                  :data-motion-index="entry.motionIndex"
                  :style="entry.style"
                  @click.stop="emit('seek', entry.word.startTime * 1000)"
                >
                  <span class="dom-word-glow" aria-hidden="true"
                    ><span v-for="(glyph, index) in entry.glyphs" :key="index">{{
                      glyph.char
                    }}</span></span
                  >
                  <span class="dom-word-body">{{ entry.word.text }}</span>
                  <span
                    v-if="activeLine.isChorus && wordAnimation && !reduced"
                    class="dom-ripple"
                    aria-hidden="true"
                  />
                </span>
              </div>
            </div>
            <div v-else class="dom-empty" role="status">{{ emptyText }}</div>
          </Transition>
        </div>
      </div>
    </div>
    <div
      v-if="subtitle"
      class="dom-subtitle"
      role="button"
      tabindex="0"
      @click="emit('seek', subtitle.seek)"
      @keydown.enter.prevent="emit('seek', subtitle.seek)"
      @keydown.space.prevent="emit('seek', subtitle.seek)"
    >
      <div v-if="subtitle.romanization" class="dom-romanization">{{ subtitle.romanization }}</div>
      <div v-if="subtitle.translation" class="dom-translation">{{ subtitle.translation }}</div>
      <div v-if="subtitle.upcoming" class="dom-upcoming">{{ subtitle.upcoming }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  shallowRef,
  watch,
  type CSSProperties,
  type Ref,
} from "vue";
import {
  useDocumentVisibility,
  useElementSize,
  useElementVisibility,
  usePreferredReducedMotion,
} from "@vueuse/core";
import type { StageLine } from "./model";
import { cssColor, stageLineIndex, stageTheme } from "./model";
import { useWordMotion, type MotionItem } from "./useWordMotion";
import type { Word } from "./vendor/types";
import {
  getOrBuildPartitaLayout,
  buildPartitaWordConfigs,
  type PartitaSequentialLayout,
} from "./vendor/components/visualizer/partita/partitaLayout";
import { buildClassicLayout } from "./vendor/components/visualizer/classic/classicLayout";
import {
  buildDisplayWordsFromLayoutUnits,
  buildPostLyricLayoutUnits,
} from "./vendor/utils/lyrics/cjkSemanticLayout";
import { resolveLyricTextDirection } from "./vendor/utils/lyrics/textDirection";
import { resolveGlowWordRenderProfile } from "./vendor/components/visualizer/glowWordTiming";
import { buildWordGraphemeTimings } from "@/components/LyricPV/vendor/utils/lyrics/graphemeTiming";
import { getGlowWordOverflow } from "./vendor/components/visualizer/glowWordOverlap";
import { getPartitaOverlapSpacing } from "./vendor/components/visualizer/partita/partitaOverlap";
import { measureGlowWordWidth } from "./vendor/components/visualizer/glowWordOverlap";
import { getLyricLanguage } from "@/utils/lyric/language";
import { splitLyricGraphemes } from "@/components/Partita/model";
import { fitStageContent } from "./fit";
import "./stage.scss";

// 云阶和流光共用宿主；上游算法决定构图，容器只负责尺寸、时钟和生命周期。
const props = withDefaults(
  defineProps<{
    mode: "partita" | "classic";
    lines: StageLine[];
    clock: { time: Readonly<Ref<number>> };
    playing?: boolean;
    loading?: boolean;
    wordAnimation?: boolean;
    fontSize?: number;
    translationSize?: number;
    romanizationSize?: number;
    color?: string;
    showTranslation?: boolean;
    showRomanization?: boolean;
    showUpcoming?: boolean;
    showGuideLines?: boolean;
    staggerMin?: number;
    staggerMax?: number;
    enableWordRotation?: boolean;
    breathing?: number;
    wordSpacing?: number;
    emptyText?: string;
    seekLabel?: string;
  }>(),
  {
    playing: true,
    loading: false,
    wordAnimation: true,
    fontSize: 46,
    translationSize: 20,
    romanizationSize: 16,
    color: "239, 239, 239",
    showTranslation: true,
    showRomanization: true,
    showUpcoming: true,
    showGuideLines: true,
    staggerMin: 12,
    staggerMax: 36,
    enableWordRotation: true,
    breathing: 1,
    wordSpacing: 0.7,
    emptyText: "",
    seekLabel: "",
  },
);
const emit = defineEmits<{ seek: [time: number] }>();
const root = ref<HTMLElement | null>(null);
const viewport = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const { width, height } = useElementSize(viewport);
const elementVisible = useElementVisibility(root);
const documentVisibility = useDocumentVisibility();
const preference = usePreferredReducedMotion();
const reduced = computed(() => preference.value === "reduce");
const running = computed(
  () =>
    props.playing &&
    !props.loading &&
    elementVisible.value &&
    documentVisibility.value === "visible",
);
const index = shallowRef(-1);
function syncLine() {
  index.value = stageLineIndex(props.lines, props.clock.time.value / 1000);
}
watch([() => props.lines, props.clock.time], syncLine, { immediate: true, flush: "sync" });
const activeLine = computed(() => props.lines[index.value] ?? null);
const profile = computed(() => resolveGlowWordRenderProfile(activeLine.value));
const fontsEpoch = ref(0);
const theme = computed(() => {
  void fontsEpoch.value;
  return stageTheme(props.color, root.value, activeLine.value?.fullText);
});
const fontPx = computed(() => {
  const scale = props.fontSize / 46;
  const line = activeLine.value;
  const graphemes = line
    ? Math.max(splitLyricGraphemes(line.fullText.replace(/\s+/g, "")).length, line.words.length)
    : 0;
  const density = props.mode === "partita" && graphemes > 40 ? 0.8 : 1;
  return (
    Math.min(
      72 * scale,
      Math.max(
        (props.mode === "partita" ? 40 : 36) * scale,
        (width.value || 800) * (props.mode === "partita" ? 0.055 : 0.06) * scale,
      ),
    ) * density
  );
});
const cache = new Map<string, PartitaSequentialLayout>();
watch(
  () => props.lines,
  () => cache.clear(),
  { flush: "sync" },
);
interface WordEntry {
  key: string;
  word: Word;
  glyphs: ReturnType<typeof buildWordGraphemeTimings>;
  motionIndex: number;
  style: CSSProperties;
}
interface Row {
  key: string;
  motionIndex?: number;
  guide?: "left" | "right";
  direction: "ltr" | "rtl";
  words: WordEntry[];
  style: CSSProperties;
}
const layout = computed(() => {
  const line = activeLine.value;
  const rows: Row[] = [];
  const items: MotionItem[] = [];
  let lineStyle: CSSProperties = {};
  if (!line) return { rows, items, lineStyle };
  const entry = (
    word: Word,
    config: MotionItem["config"],
    style: CSSProperties,
    key: string,
  ): WordEntry => {
    const motionIndex = items.push({ word, config }) - 1;
    return { key, word, glyphs: buildWordGraphemeTimings(word), motionIndex, style };
  };
  if (props.mode === "partita") {
    const partita = getOrBuildPartitaLayout(cache, line, theme.value, height.value || 500, {
      showGuideLines: props.showGuideLines,
      useSemanticLayout: true,
      staggerMin: props.staggerMin,
      staggerMax: props.staggerMax,
      avoidOverlap: true,
    });
    for (const column of partita.columns) {
      const spacings = getPartitaOverlapSpacing(
        column.words.map((chunk) => ({
          widthsEm: chunk.displayWords.map(
            (word) =>
              measureGlowWordWidth(
                word.text,
                100,
                theme.value.fontFamily ?? "sans-serif",
                theme.value.fontWeight ?? 700,
              ) / 100,
          ),
          wordConfigs: buildPartitaWordConfigs(
            chunk.displayWords,
            chunk.config,
            theme.value.animationIntensity,
          ),
          config: chunk.config,
          rtl:
            resolveLyricTextDirection(chunk.displayWords.map((word) => word.text).join(" ")) ===
            "rtl",
        })),
      );
      let rowIndex = 0;
      for (const chunk of column.words) {
        const guide = chunk.rowIndex % 2 === 0 ? "left" : "right";
        const motionIndex =
          items.push({
            word: {
              text: chunk.displayWords.map((w) => w.text).join(""),
              startTime: chunk.chunkWords[0].startTime,
              endTime: chunk.chunkWords.at(-1)!.endTime,
            },
            config: chunk.config,
            chunk: true,
            guide,
          }) - 1;
        const configs = buildPartitaWordConfigs(
          chunk.displayWords,
          chunk.config,
          theme.value.animationIntensity,
        );
        const spacing = spacings[rowIndex++];
        rows.push({
          key: chunk.config.id,
          motionIndex,
          guide,
          direction: resolveLyricTextDirection(chunk.displayWords.map((w) => w.text).join(" ")),
          style: { marginTop: spacing.marginTop, marginBottom: spacing.marginBottom },
          words: chunk.displayWords.map((word, i) =>
            entry(word, configs[i], spacing.words[i], `${chunk.config.id}-${i}`),
          ),
        });
      }
    }
    lineStyle = { perspective: `${partita.lineConfig.perspective}px` };
  } else {
    const displayWords = buildDisplayWordsFromLayoutUnits(
      buildPostLyricLayoutUnits(line, { semantic: true, sticky: true }),
    );
    const classic = buildClassicLayout(
      line,
      displayWords,
      theme.value,
      {
        enableWordRotation: props.enableWordRotation,
        breathingFloatMultiplier: props.breathing,
        useLegacyLayout: false,
        wordSpacing: props.wordSpacing,
        avoidOverlap: true,
      },
      width.value || 800,
      props.fontSize / 46,
    );
    const justify = classic.lineConfig.justifyContent.replace("justify-", "");
    const align = classic.lineConfig.alignItems.replace("items-", "");
    rows.push({
      key: line.key,
      direction: resolveLyricTextDirection(line.fullText),
      style: {
        rowGap: `${classic.lineConfig.rowGap ?? 10}px`,
        paddingTop: `${classic.lineConfig.reachTop ?? 0}px`,
        paddingBottom: `${classic.lineConfig.reachBottom ?? 0}px`,
        justifyContent:
          justify === "start"
            ? "flex-start"
            : justify === "end"
              ? "flex-end"
              : justify === "around"
                ? "space-around"
                : justify === "between"
                  ? "space-between"
                  : "center",
        alignItems: align === "start" ? "flex-start" : align === "end" ? "flex-end" : "center",
      },
      words: displayWords.map((word, i) =>
        entry(
          word,
          classic.wordConfigs[i],
          { marginInlineEnd: classic.wordConfigs[i].marginRight },
          `${line.key}-${i}`,
        ),
      ),
    });
    lineStyle = { perspective: `${classic.lineConfig.perspective}px` };
  }
  return { rows, items, lineStyle };
});
const lineStyle = computed(() => layout.value.lineStyle);
const motionOptions = computed(() => ({
  items: layout.value.items,
  line: activeLine.value,
  color: cssColor(props.color),
  wordAnimation: props.wordAnimation,
  visible: elementVisible.value && documentVisibility.value === "visible",
  rotation: props.enableWordRotation,
}));
useWordMotion(content, props.clock.time, running, reduced, () => motionOptions.value);
const fit = ref(1);
let disposed = false;
async function measureFit() {
  await nextTick();
  if (disposed || !content.value || !viewport.value) return;
  const element = content.value;
  let extraX = 0,
    extraY = 0;
  for (const node of element.querySelectorAll<HTMLElement>(".dom-word")) {
    const item = layout.value.items[Number(node.dataset.motionIndex)];
    if (!item) continue;
    const overflow = getGlowWordOverflow(node.offsetWidth, fontPx.value, item.config, item.config);
    extraX = Math.max(extraX, overflow.left, overflow.right);
    extraY = Math.max(extraY, overflow.top, overflow.bottom);
  }
  const chunkX = Math.max(
    0,
    ...layout.value.items.filter((item) => item.chunk).map((item) => Math.abs(item.config.x)),
  );
  fit.value = fitStageContent(
    width.value,
    height.value,
    element.scrollWidth + 2 * (extraX + chunkX),
    element.scrollHeight + 2 * extraY,
  );
}
watch([layout, width, height, fontPx, content], measureFit, { flush: "post" });
function onFontsLoaded() {
  cache.clear();
  fontsEpoch.value++;
}
let fontSignature = "";
onUpdated(() => {
  if (!root.value) return;
  const font = stageTheme(props.color, root.value, activeLine.value?.fullText);
  const signature = `${font.fontFamily}|${font.fontWeight}`;
  if (signature !== fontSignature) {
    fontSignature = signature;
    onFontsLoaded();
  }
});
onMounted(() => {
  document.fonts?.addEventListener("loadingdone", onFontsLoaded);
  void document.fonts?.ready.then(() => {
    if (!disposed) onFontsLoaded();
  });
});
onBeforeUnmount(() => {
  disposed = true;
  cache.clear();
  document.fonts?.removeEventListener("loadingdone", onFontsLoaded);
});
function prepareEnter(element: Element) {
  if (!(element instanceof HTMLElement)) return;
  const mode = profile.value?.lineTransitionMode;
  element.style.setProperty(
    "--enter-duration",
    reduced.value || mode === "none" ? "0s" : mode === "fast" ? "0.16s" : "0.3s",
  );
}
function prepareLeave(element: Element) {
  if (!(element instanceof HTMLElement)) return;
  element.setAttribute("inert", "");
  element.style.pointerEvents = "none";
}
const subtitle = computed(() => {
  if (props.loading) return null;
  const line = activeLine.value;
  const translation = props.showTranslation ? line?.translation?.trim() : "";
  const romanization = props.showRomanization ? line?.romanization?.trim() : "";
  if (line && (translation || romanization))
    return { translation, romanization, seek: line.startTime * 1000 };
  const upcoming = props.showUpcoming
    ? props.lines.slice(Math.max(0, index.value + 1)).find((item) => !item.isInterlude)
    : null;
  return upcoming ? { upcoming: upcoming.fullText, seek: upcoming.startTime * 1000 } : null;
});
const stageStyle = computed(() => ({
  "--dom-color": cssColor(props.color),
  "--dom-font-size": `${fontPx.value}px`,
  "--dom-translation-size": `${props.translationSize}px`,
  "--dom-romanization-size": `${props.romanizationSize}px`,
  "--dom-play-state": running.value ? "running" : "paused",
  "--dom-breath-distance": `${14 * props.breathing}px`,
  "--dom-breath-peak": 1 + 0.01 * props.breathing,
  "--dom-breath-trough": 1 - 0.005 * props.breathing,
}));
</script>
