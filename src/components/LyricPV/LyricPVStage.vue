<template>
  <div
    ref="root"
    class="lyric-pv"
    :class="[mode, { 'full-bleed': fullBleed }]"
    :style="fullBleed && safeArea ? { '--pv-safe-bottom': `${safeArea.bottom * 100}%` } : undefined"
  >
    <div ref="host" class="pv-canvas" aria-hidden="true" />
    <div v-if="!ready && !failed" class="pv-fallback">{{ current?.fullText || emptyText }}</div>
    <button
      v-if="current"
      type="button"
      :class="failed ? 'pv-fallback' : 'pv-accessible-lyric'"
      @click="emit('seek', current.startTime)"
    >
      {{ current.fullText }}
    </button>
    <div v-if="current" class="pv-subtitles">
      <button
        v-if="showTranslation && current.translation"
        type="button"
        :style="{ fontSize: `${translationSize}px` }"
        @click="emit('seek', current.startTime)"
      >
        {{ current.translation }}
      </button>
      <button
        v-if="showRomanization && current.romanization"
        type="button"
        :style="{ fontSize: `${romanizationSize}px` }"
        @click="emit('seek', current.startTime)"
      >
        {{ current.romanization }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from "vue";
import {
  useDocumentVisibility,
  useElementVisibility,
  usePreferredReducedMotion,
} from "@vueuse/core";
import { resolvePartitaFrame, type PartitaLine } from "@/components/Partita/model";
import { useStageClock } from "@/components/LyricStage/useStageClock";
import { retireCanvasScene } from "@/components/LyricStage/retireCanvasScene";
import { adaptPVLines, createPVTheme } from "./model";
import { createPVAudioSignals } from "./audio";
import { createPVRuntime, type PVMode, type PVRuntime, type PVSong } from "./runtime";
import { usePVSafeArea } from "./usePVSafeArea";
import audioManager from "@/utils/audioManager";

// Vue 管理宿主与离散状态，原版 Pixi 引擎只在自己的渲染循环中读取播放时钟。
const props = withDefaults(
  defineProps<{
    mode: PVMode;
    fullBleed?: boolean;
    lines: PartitaLine[];
    clock: { time: Readonly<Ref<number>> };
    seed: string;
    duration: number;
    playing: boolean;
    visible?: boolean;
    preview?: boolean;
    title?: string;
    artist?: string;
    album?: string;
    color?: string;
    wordAnimation?: boolean;
    showTranslation?: boolean;
    showRomanization?: boolean;
    translationSize?: number;
    romanizationSize?: number;
    emptyText?: string;
  }>(),
  {
    visible: true,
    fullBleed: false,
    preview: false,
    title: "",
    artist: "",
    album: "",
    color: "239, 239, 239",
    wordAnimation: true,
    showTranslation: true,
    showRomanization: true,
    translationSize: 20,
    romanizationSize: 16,
    emptyText: "",
  },
);
const emit = defineEmits<{ seek: [time: number] }>();
const root = ref<HTMLDivElement>();
const host = ref<HTMLDivElement>();
const safeArea = usePVSafeArea(root, () => props.fullBleed);
const ready = ref(false);
const failed = ref(false);
const visibility = useDocumentVisibility();
const preference = usePreferredReducedMotion();
const reduced = computed(() => preference.value === "reduce");
const onScreen = useElementVisibility(root);
const active = computed(() => props.visible && onScreen.value && visibility.value === "visible");
const paused = computed(() => !props.playing || !active.value);
const font = shallowRef({ family: "system-ui", weight: 700 });
const lines = computed(() => adaptPVLines(props.lines, props.wordAnimation));
const song = computed<PVSong>(() => ({
  seed: props.seed,
  lines: lines.value,
  duration: props.duration / 1000,
  theme: createPVTheme(
    props.color,
    font.value.family,
    font.value.weight,
    reduced.value,
    safeArea.value,
  ),
  title: props.title,
  artist: props.artist,
  album: props.album,
}));
const stageClock = useStageClock(() => props.lines, props.clock.time);
const current = computed(() => resolvePartitaFrame(props.lines, stageClock.value).activeLine);
const audio = createPVAudioSignals(() => !props.preview && !paused.value);
let runtime: PVRuntime | undefined;
let creation: AbortController | undefined;
let swap: AbortController | undefined;
let disposed = false;

function readFont() {
  if (!root.value) return;
  const style = getComputedStyle(root.value);
  const next = { family: style.fontFamily, weight: Number.parseInt(style.fontWeight) || 700 };
  if (next.family !== font.value.family || next.weight !== font.value.weight) font.value = next;
}
function release() {
  creation?.abort();
  swap?.abort();
  const previous = runtime;
  runtime = undefined;
  ready.value = false;
  if (previous) {
    previous.setPaused(true);
    retireCanvasScene(previous, host.value?.querySelector("canvas") ?? undefined);
  }
}
const fontObserver = new MutationObserver(readFont);
function contextLost(event: Event) {
  event.preventDefault();
  void start();
}
async function start() {
  release();
  if (disposed || !host.value || !props.visible) return;
  failed.value = false;
  const controller = new AbortController();
  creation = controller;
  const initial = song.value;
  try {
    const next = await createPVRuntime(props.mode, {
      host: host.value,
      song: initial,
      currentTime: { get: () => props.clock.time.value / 1000 },
      ...audio,
      paused: paused.value,
      reduced: reduced.value,
      signal: controller.signal,
    });
    if (disposed || controller.signal.aborted) {
      next.destroy();
      return;
    }
    runtime = next;
    if (song.value !== initial) await updateSong(song.value);
    if (disposed || controller.signal.aborted) return;
    next.setPaused(paused.value);
    next.setStaticMode(reduced.value);
    ready.value = true;
  } catch (error) {
    if (controller.signal.aborted || disposed) return;
    failed.value = true;
    console.warn(`[LyricPV] ${props.mode} 初始化失败`, error);
  }
}
async function updateSong(next: PVSong) {
  const target = runtime;
  if (!target) return;
  swap?.abort();
  const controller = new AbortController();
  swap = controller;
  try {
    await target.swapSong(next, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted && !disposed) console.warn("[LyricPV] 更新歌曲失败", error);
  }
}
function onSeek() {
  runtime?.seek?.();
}
onMounted(() => {
  readFont();
  if (root.value) {
    fontObserver.observe(root.value, { attributes: true, attributeFilter: ["style"] });
    root.value.addEventListener("webglcontextlost", contextLost, true);
  }
  document.fonts.addEventListener("loadingdone", readFont);
  audioManager.on("seeked", onSeek);
  void start();
});
watch(
  [() => props.mode, () => props.visible],
  () => {
    void start();
  },
  { flush: "post" },
);
watch(
  song,
  (next) => {
    void updateSong(next);
  },
  { flush: "post" },
);
watch(paused, (value) => runtime?.setPaused(value));
watch(reduced, (value) => runtime?.setStaticMode(value));
watch(
  () => props.clock.time.value,
  () => {
    if (paused.value && active.value) runtime?.renderOnce();
  },
);
onBeforeUnmount(() => {
  disposed = true;
  fontObserver.disconnect();
  root.value?.removeEventListener("webglcontextlost", contextLost, true);
  document.fonts.removeEventListener("loadingdone", readFont);
  audioManager.off("seeked", onSeek);
  release();
});
</script>

<style scoped lang="scss">
.lyric-pv {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  isolation: isolate;
  color: #f5f4f0;
  background: transparent;
  &.full-bleed {
    .pv-canvas {
      mask-image: none;
    }
    .pv-subtitles {
      bottom: calc(var(--pv-safe-bottom, 104px) + 12px);
    }
  }
}
.pv-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
  // 只让画布边沿逐渐透明，避免光束和辉光在歌词区域边界被硬切。
  mask-image:
    linear-gradient(90deg, transparent, #000 24px, #000 calc(100% - 24px), transparent),
    linear-gradient(180deg, transparent, #000 32px, #000 calc(100% - 32px), transparent);
  mask-composite: intersect;
}
.pv-accessible-lyric {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  &:focus-visible {
    width: auto;
    height: auto;
    inset: 12px 8% auto;
    padding: 8px;
    clip-path: none;
    white-space: normal;
    background: #10111d;
    color: inherit;
    outline: 2px solid currentColor;
  }
}
.pv-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: clamp(20px, 3vw, 40px);
}
.pv-subtitles {
  position: absolute;
  bottom: 6%;
  inset-inline: 8%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  text-align: center;
  text-shadow: 0 2px 8px #000;
  button {
    border: 0;
    padding: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  button:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 4px;
  }
}
</style>
