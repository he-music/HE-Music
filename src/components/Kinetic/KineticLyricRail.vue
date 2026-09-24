<template>
  <KineticDomRail v-if="fallback" v-bind="props" @seek="emit('seek', $event)" />
  <div
    v-else
    ref="rail"
    class="kinetic-rail"
    :style="{ color: `rgb(${color})` }"
    @wheel.prevent="browse($event.deltaY * ($event.deltaMode === 1 ? 24 : 1))"
    @touchstart.passive="touchY = $event.touches[0]?.clientY ?? 0"
    @touchmove.prevent="onTouchMove"
  >
    <canvas
      ref="canvas"
      class="kinetic-canvas"
      :style="{ visibility: canvasReady ? 'visible' : 'hidden' }"
      aria-hidden="true"
      @webglcontextlost.prevent="useFallback"
    />
    <div ref="hitTrack" class="kinetic-hit-track">
      <button
        v-for="row in layout.rows"
        :key="row.line.key"
        type="button"
        class="kinetic-hit-row"
        :disabled="row.line.isInterlude"
        :aria-label="
          [row.line.fullText, ...row.translation, ...row.romanization].filter(Boolean).join(' ')
        "
        :style="{ top: `${row.y - fontSize * 0.7}px`, height: `${row.height + fontSize * 0.7}px` }"
        @click="seek(row.line.startTime)"
        @focus="focusRow($event, row.y)"
      />
    </div>
    <div v-if="!lines.length" class="kinetic-empty">{{ emptyText }}</div>
    <button v-if="browsing" type="button" class="kinetic-resume" @click="resume">
      {{ resumeText }}
    </button>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Ref,
} from "vue";
import { useDocumentVisibility, useElementSize, usePreferredReducedMotion } from "@vueuse/core";
import { Color } from "@pixi/core";
import type { PartitaLine } from "../Partita/model";
import { buildKineticLayout, kineticCamera } from "./model";
import type { KineticJumpGranularity } from "@/utils/lyric/kinetic";
import { KineticScene } from "./KineticScene";
import { retireKineticScene } from "./lifecycle";

const KineticDomRail = defineAsyncComponent(() => import("./KineticDomRail.vue"));
const props = withDefaults(
  defineProps<{
    lines: PartitaLine[];
    clock: { time: Readonly<Ref<number>> };
    wordAnimation?: boolean;
    jumpGranularity?: KineticJumpGranularity;
    fontSize?: number;
    translationSize?: number;
    romanizationSize?: number;
    showTranslation?: boolean;
    showRomanization?: boolean;
    color?: string;
    emptyText?: string;
    resumeText?: string;
  }>(),
  {
    wordAnimation: true,
    jumpGranularity: "auto",
    fontSize: 36,
    translationSize: 18,
    romanizationSize: 16,
    showTranslation: true,
    showRomanization: true,
    color: "255, 255, 255",
    emptyText: "",
    resumeText: "",
  },
);
const emit = defineEmits<{ seek: [time: number] }>();
const rail = ref<HTMLElement>();
const canvas = ref<HTMLCanvasElement>();
const canvasReady = ref(false);
const hitTrack = ref<HTMLElement>();
const fallback = ref(false);
const browsing = ref(false);
const { width, height } = useElementSize(rail);
const visibility = useDocumentVisibility();
const preference = usePreferredReducedMotion();
const reduced = computed(() => preference.value === "reduce");
const font = ref({ family: "sans-serif", weight: "700", style: "normal" });
const fontVersion = ref(0);
const typography = computed(() => ({
  ...font.value,
  fontRevision: fontVersion.value,
  size: props.fontSize,
  translationSize: props.translationSize,
  romanizationSize: props.romanizationSize,
}));
const colorValue = computed(() => new Color(`rgb(${props.color})`).toNumber());
const context = document.createElement("canvas").getContext("2d")!;
const layout = computed(() => {
  void fontVersion.value;
  return buildKineticLayout(
    props.lines,
    width.value,
    props.fontSize,
    (text, size) => {
      context.font = `${font.value.style} ${font.value.weight} ${size}px ${font.value.family}`;
      return context.measureText(text).width;
    },
    {
      animate: props.wordAnimation && !reduced.value,
      jumpGranularity: props.jumpGranularity,
      translationSize: props.translationSize,
      romanizationSize: props.romanizationSize,
      showTranslation: props.showTranslation,
      showRomanization: props.showRomanization,
    },
  );
});
let scene: KineticScene | undefined;
let hitRows: HTMLElement[] = [];
let browseY = 0;
let touchY = 0;
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

function useFallback() {
  if (disposed || fallback.value) return;
  fallback.value = true;
  const previous = scene;
  scene = undefined;
  if (previous) retireKineticScene(previous, canvas.value);
}
function draw() {
  if (disposed || !scene || visibility.value !== "visible") return;
  try {
    const shift = scene.render(
      props.clock.time.value,
      width.value,
      height.value,
      colorValue.value,
      reduced.value,
      browsing.value ? browseY : undefined,
    );
    if (shift === undefined || !hitTrack.value) return;
    canvasReady.value = true;
    // Only one DOM camera transform and a visibility flag per row remain.
    const transform = `translate3d(0, ${shift}px, 0)`;
    if (hitTrack.value.style.transform !== transform) hitTrack.value.style.transform = transform;
    layout.value.rows.forEach((row, index) => {
      const element = hitRows[index];
      if (element) {
        const visibility =
          row.y + shift + row.height >= 0 && row.y + shift <= height.value + props.fontSize
            ? "visible"
            : "hidden";
        if (element.style.visibility !== visibility) element.style.visibility = visibility;
      }
    });
  } catch (error) {
    console.warn("Kinetic WebGL rendering unavailable, using DOM fallback", error);
    useFallback();
  }
}
async function rebuild() {
  await nextTick();
  if (!scene || disposed) return;
  hitRows = Array.from(hitTrack.value?.querySelectorAll<HTMLElement>(".kinetic-hit-row") ?? []);
  scene.setLayout(layout.value, typography.value);
  draw();
}
function readFont() {
  if (!rail.value) return;
  const style = getComputedStyle(rail.value);
  const next = { family: style.fontFamily, weight: style.fontWeight, style: style.fontStyle };
  if (JSON.stringify(next) !== JSON.stringify(font.value)) font.value = next;
}
function fontsLoaded() {
  readFont();
  fontVersion.value++;
}
const observer = new MutationObserver(readFont);
onMounted(() => {
  readFont();
  if (rail.value?.parentElement)
    observer.observe(rail.value.parentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
  document.fonts.addEventListener("loadingdone", fontsLoaded);
  try {
    scene = new KineticScene(canvas.value!, typography.value);
    void rebuild();
  } catch (error) {
    console.warn("Kinetic WebGL initialization unavailable, using DOM fallback", error);
    useFallback();
  }
});
const stopLayout = watch(layout, rebuild, { flush: "post" });
const stopDrawing = watch([() => props.clock.time.value, height, colorValue, visibility], draw, {
  flush: "post",
});
const stopLines = watch(() => props.lines, resume);
function resume() {
  clearTimeout(resumeTimer);
  browsing.value = false;
  scene?.clearTrail(props.clock.time.value);
  draw();
}
function holdBrowse() {
  browsing.value = true;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(resume, 4000);
  draw();
}
function browse(delta: number) {
  if (!browsing.value)
    browseY = kineticCamera(layout.value, props.clock.time.value, reduced.value).y;
  const last = layout.value.rows.at(-1);
  browseY = Math.max(0, Math.min((last?.y ?? 0) + (last?.height ?? 0), browseY + delta));
  holdBrowse();
}
function focusRow(event: FocusEvent, y: number) {
  if (!(event.currentTarget as HTMLElement).matches(":focus-visible")) return;
  browseY = y;
  holdBrowse();
}
function onTouchMove(event: TouchEvent) {
  const y = event.touches[0]?.clientY ?? touchY;
  browse(touchY - y);
  touchY = y;
}
function seek(time: number) {
  resume();
  emit("seek", time);
}
onBeforeUnmount(() => {
  disposed = true;
  stopDrawing();
  stopLayout();
  stopLines();
  clearTimeout(resumeTimer);
  observer.disconnect();
  document.fonts.removeEventListener("loadingdone", fontsLoaded);
  const previous = scene;
  scene = undefined;
  if (previous) retireKineticScene(previous, canvas.value);
});
</script>

<style scoped lang="scss">
.kinetic-rail {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
  font-weight: var(--kinetic-font-weight, 700);
  mask-image: linear-gradient(transparent, #000 9%, #000 88%, transparent);
  background: radial-gradient(ellipse at center, rgba(255, 255, 255, 0.035), transparent 70%);
}
.kinetic-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.kinetic-hit-track {
  position: absolute;
  inset: 0;
  will-change: transform;
}
.kinetic-hit-row {
  position: absolute;
  left: 0;
  width: 100%;
  border: 0;
  outline: none;
  padding: 0;
  background: transparent;
  cursor: pointer;
  &:disabled {
    cursor: default;
  }
}
.kinetic-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0.5;
  font-weight: 400;
  pointer-events: none;
}
.kinetic-resume {
  position: absolute;
  bottom: 12%;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 24px;
  border: 1px solid currentColor;
  background: rgba(0, 0, 0, 0.6);
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
</style>
