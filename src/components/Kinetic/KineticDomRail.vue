<template>
  <div
    ref="rail"
    class="kinetic-rail"
    :style="{ color: `rgb(${color})`, '--kinetic-size': `${fontSize}px` }"
    @wheel.prevent="browse($event.deltaY * ($event.deltaMode === 1 ? 24 : 1))"
    @touchstart.passive="touchY = $event.touches[0]?.clientY ?? 0"
    @touchmove.prevent="onTouchMove"
  >
    <div v-if="!lines.length" class="kinetic-empty">{{ emptyText }}</div>
    <div ref="track" class="kinetic-track">
      <button
        v-for="row in layout.rows"
        :key="row.line.key"
        class="kinetic-row"
        type="button"
        :aria-label="row.line.fullText"
        :disabled="row.line.isInterlude"
        :style="{ top: `${row.y}px`, height: `${row.height}px` }"
        @click="seek(row.line.startTime)"
        @focus="focusRow($event, row.y)"
      >
        <span v-if="row.glyphs.length" aria-hidden="true">
          <span
            v-for="(glyph, index) in row.glyphs"
            :key="index"
            class="kinetic-glyph"
            :style="{
              left: `${glyph.x}px`,
              top: `${glyph.y}px`,
              width: `${glyph.width}px`,
              transform: `translate(-50%, -50%) rotate(${glyph.rotation}deg)`,
            }"
            >{{ glyph.char }}</span
          >
        </span>
        <span v-else class="kinetic-paragraph" dir="auto">
          <span v-for="(text, index) in row.paragraphs" :key="index">{{ text }}</span>
        </span>
        <span class="kinetic-subtitles" :style="{ top: `${row.subtitleY}px` }" dir="auto">
          <span
            v-for="(text, index) in row.translation"
            :key="`t${index}`"
            :style="{ fontSize: `${translationSize}px` }"
            >{{ text }}</span
          >
          <span
            v-for="(text, index) in row.romanization"
            :key="`r${index}`"
            :style="{ fontSize: `${romanizationSize}px` }"
            >{{ text }}</span
          >
        </span>
      </button>
    </div>
    <svg ref="notes" class="kinetic-notes" width="100%" height="100%" aria-hidden="true">
      <g class="kinetic-trail">
        <path v-for="index in 24" :key="index" />
      </g>
      <g class="kinetic-impact">
        <circle cx="0" cy="0" r="18" />
      </g>
      <g class="kinetic-note">
        <ellipse cx="-4" cy="0" rx="7" ry="5" transform="rotate(-24)" fill="currentColor" />
        <path
          d="M2 0V-23C3-17 12-18 10-10"
          fill="none"
          stroke="currentColor"
          stroke-width="2.7"
          stroke-linecap="round"
        />
      </g>
    </svg>
    <button v-if="browsing" class="kinetic-resume" type="button" @click="resume">
      {{ resumeText }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { useElementSize, usePreferredReducedMotion } from "@vueuse/core";
import type { KineticJumpGranularity } from "@/utils/lyric/kinetic";
import type { PartitaLine } from "../Partita/model";
import {
  buildKineticLayout,
  clamp,
  kineticCamera,
  kineticImpact,
  kineticNote,
  kineticTrail,
} from "./model";

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
const track = ref<HTMLElement>();
const notes = ref<SVGSVGElement>();
const { width, height } = useElementSize(rail);
const reducedMotion = usePreferredReducedMotion();
const reduced = computed(() => reducedMotion.value === "reduce");
const font = ref({ family: "sans-serif", weight: "700", style: "normal" });
const fontVersion = ref(0);
const context = document.createElement("canvas").getContext("2d");
const layout = computed(() => {
  void fontVersion.value;
  return buildKineticLayout(
    props.lines,
    width.value,
    props.fontSize,
    (text, size) => {
      if (!context) return text.length * size;
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

let rowElements: HTMLElement[] = [];
let glyphElements: HTMLElement[][] = [];
let subtitleElements: HTMLElement[] = [];
let noteElement: SVGGElement | null = null;
let impactElement: SVGGElement | null = null;
let trailPaths: SVGPathElement[] = [];
let lastTime = -Infinity;
let trailStart = 0;
const browsing = ref(false);
let browseY = 0;
let touchY = 0;
let resumeTimer: ReturnType<typeof setTimeout> | undefined;

// Animation only mutates the visible glyphs and one camera transform. Vue's
// lyric tree is rebuilt only for lyrics, typography or viewport changes.
function render() {
  const time = props.clock.time.value;
  if (time < lastTime || time - lastTime > 250) trailStart = time;
  lastTime = time;
  const camera = kineticCamera(layout.value, time, reduced.value);
  const focusY = browsing.value ? browseY : camera.y;
  const shift = height.value * 0.48 - focusY;
  if (track.value) track.value.style.transform = `translate3d(0, ${shift}px, 0)`;
  layout.value.rows.forEach((row, index) => {
    const element = rowElements[index];
    if (!element) return;
    const screenY = row.y + shift;
    const visible = screenY + row.height > -80 && screenY < height.value + 80;
    element.style.visibility = visible ? "visible" : "hidden";
    if (!visible) return;
    const focus =
      camera.row === camera.nextRow
        ? Number(index === camera.row)
        : index === camera.row
          ? 1 - camera.progress
          : index === camera.nextRow
            ? camera.progress
            : 0;
    element.style.opacity = String(
      browsing.value
        ? 0.65
        : (screenY < height.value * 0.48 ? 0.16 : 0.28) +
            focus * (screenY < height.value * 0.48 ? 0.84 : 0.72),
    );
    if (subtitleElements[index])
      subtitleElements[index].style.opacity = String(browsing.value ? 0.8 : focus * 0.8);
    row.glyphs.forEach((glyph, i) => {
      const el = glyphElements[index]?.[i];
      if (!el) return;
      const age = time - glyph.startTime;
      const impact = age >= 0 && age < 260 ? Math.sin((age / 260) * Math.PI) : 0;
      const progress = clamp(
        (time - glyph.startTime) / Math.max(1, glyph.endTime - glyph.startTime),
      );
      el.style.transform = `translate(-50%, -50%) translateY(${impact * props.fontSize * 0.12}px) rotate(${glyph.rotation}deg) scale(${1 + impact * 0.06})`;
      el.style.opacity = String(time >= glyph.startTime ? 1 : 0.48);
      el.style.textShadow =
        time >= glyph.startTime && time <= glyph.endTime && !browsing.value
          ? `0 0 ${8 + progress * 10}px currentColor`
          : "none";
    });
  });
  const pose = browsing.value
    ? null
    : kineticNote(layout.value, time, props.fontSize, reduced.value);
  const impact = browsing.value || reduced.value ? null : kineticImpact(layout.value, time);
  if (noteElement) {
    noteElement.style.opacity = String(pose?.opacity ?? 0);
    if (pose) {
      noteElement.setAttribute(
        "transform",
        `translate(${pose.x} ${pose.y + shift}) rotate(${pose.rotation}) scale(${Math.max(0.65, props.fontSize / 40)})`,
      );
      noteElement.style.filter = `drop-shadow(0 0 ${6 * pose.glow}px currentColor)`;
    }
  }
  if (impactElement) {
    impactElement.style.opacity = String(impact ? (1 - impact.progress) * 0.55 : 0);
    if (impact) {
      const scale = ((24 + impact.progress * 92) * (props.fontSize / 72)) / 18;
      impactElement.style.strokeWidth = String((2 * (1 - impact.progress) + 0.3) / scale);
      impactElement.setAttribute(
        "transform",
        `translate(${impact.x} ${impact.y + shift}) scale(${scale})`,
      );
    }
  }
  const segments =
    !browsing.value && !reduced.value
      ? kineticTrail(layout.value, time, props.fontSize, trailStart)
      : [];
  trailPaths.forEach((path, index) => {
    const segment = segments[index];
    path.style.opacity = String(segment?.opacity ?? 0);
    if (segment) {
      path.setAttribute(
        "d",
        `M${segment.x1} ${segment.y1 + shift} L${segment.x2} ${segment.y2 + shift}`,
      );
      path.style.strokeWidth = String(segment.width);
    } else path.removeAttribute("d");
  });
}

function resume() {
  clearTimeout(resumeTimer);
  trailStart = props.clock.time.value;
  browsing.value = false;
  render();
}
function holdBrowse() {
  browsing.value = true;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(resume, 4000);
  render();
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
function readFont() {
  if (!rail.value) return;
  const style = getComputedStyle(rail.value);
  const next = { family: style.fontFamily, weight: style.fontWeight, style: style.fontStyle };
  if (JSON.stringify(next) !== JSON.stringify(font.value)) font.value = next;
}
function fontsLoaded() {
  fontVersion.value++;
  readFont();
}
const observer = new MutationObserver(readFont);
onMounted(() => {
  readFont();
  // The player wrapper carries the user's font selection.
  if (rail.value?.parentElement)
    observer.observe(rail.value.parentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
  document.fonts.addEventListener("loadingdone", fontsLoaded);
});
watch(
  layout,
  async () => {
    await nextTick();
    rowElements = Array.from(track.value?.querySelectorAll<HTMLElement>(".kinetic-row") ?? []);
    glyphElements = rowElements.map((row) =>
      Array.from(row.querySelectorAll<HTMLElement>(".kinetic-glyph")),
    );
    subtitleElements = rowElements.map(
      (row) => row.querySelector<HTMLElement>(".kinetic-subtitles")!,
    );
    noteElement = notes.value?.querySelector(".kinetic-note") ?? null;
    impactElement = notes.value?.querySelector(".kinetic-impact") ?? null;
    trailPaths = Array.from(
      notes.value?.querySelectorAll<SVGPathElement>(".kinetic-trail path") ?? [],
    );
    trailStart = props.clock.time.value;
    render();
  },
  { immediate: true, flush: "post" },
);
watch([() => props.clock.time.value, height, reduced], render, { flush: "post" });
watch(() => props.lines, resume);
onBeforeUnmount(() => {
  clearTimeout(resumeTimer);
  observer.disconnect();
  document.fonts.removeEventListener("loadingdone", fontsLoaded);
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
.kinetic-track {
  position: absolute;
  inset: 0;
  will-change: transform;
}
.kinetic-row {
  position: absolute;
  left: 0;
  width: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--kinetic-size);
  text-align: center;
  cursor: pointer;
  &:disabled {
    cursor: default;
  }
  &:focus {
    outline: none;
  }
  &:focus-visible {
    outline: none;
  }
}
.kinetic-glyph {
  position: absolute;
  white-space: pre;
  line-height: 1.4;
  transform-origin: center;
}
.kinetic-paragraph {
  position: absolute;
  top: calc(var(--kinetic-size) * -0.7);
  inset-inline: 24px;
  line-height: 1.4;
  span {
    display: block;
  }
}
.kinetic-subtitles {
  position: absolute;
  inset-inline: 24px;
  font-weight: 400;
  line-height: 1.5;
  span {
    display: block;
  }
}
.kinetic-notes {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
}
.kinetic-impact {
  opacity: 0;
  fill: none;
  stroke: currentColor;
  filter: drop-shadow(0 0 8px currentColor);
}
.kinetic-note {
  fill: currentColor;
  stroke: none;
}
.kinetic-trail {
  fill: none;
  stroke: currentColor;
  stroke-width: 3.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 8px currentColor);
}
.kinetic-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  opacity: 0.5;
  font-weight: 400;
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
