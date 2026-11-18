import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { clamp, resolveTone, SCALE_SPRING, stepSpring, type SpringValue } from "./motion";
import type { LineStatus, MonetLine } from "./model";
import { toMonetSource, monetDisplayWords } from "./upstream";
import { stageTheme } from "@/components/LyricDom/model";
import {
  resolveMonetFillWidth,
  resolveMonetGlow,
} from "@/components/LyricDom/vendor/components/visualizer/monet/monetLyricMotion";
import {
  buildPositionedEntries,
  type MonetLayoutCache,
} from "@/components/LyricDom/vendor/components/visualizer/monet/monetRailLayout";
import {
  buildMonetLayoutCacheKey,
  clearMonetMeasurementCaches,
  measureMonetGraphemeOffsets,
  measureMonetLineLayout,
  resolveMonetSweepEdgeSoftness,
  resolveMonetSweepEnd,
} from "@/components/LyricDom/vendor/components/visualizer/monet/monetLyricsModel";
import type { GraphemeTiming } from "@/components/LyricPV/vendor/utils/lyrics/graphemeTiming";
import { rememberBounded } from "@/components/LyricPV/vendor/utils/textMeasureCache";

// 莫奈沿用原版排版、弹簧与扫字包络；测量与字体失效只发生在结构变化时。
export interface RailEntry {
  line: MonetLine;
  index: number;
  offset: number;
  status: LineStatus;
}
interface Track {
  node: HTMLElement;
  y: SpringValue;
  scale: SpringValue;
  targetY: number;
  targetScale: number;
}
interface WordNode {
  node: HTMLElement;
  body: HTMLElement;
  fill: HTMLElement;
  glow: HTMLElement;
  start: number;
  end: number;
  lineEnd: number;
  status: LineStatus;
  offsets: number[];
  timings: GraphemeTiming[];
  softness: number;
  rtl: boolean;
}
interface MotionOptions {
  rail: Ref<HTMLElement | null>;
  entries: Ref<RailEntry[]>;
  clock: { time: Readonly<Ref<number>> };
  running: Readonly<Ref<boolean>>;
  visible: Readonly<Ref<boolean>>;
  reducedMotion: Readonly<Ref<boolean>>;
  alignment: () => number;
  fontSize: () => number;
  wordAnimation: () => boolean;
  longWordEffect: () => boolean;
}
export function useMonetMotion(options: MotionOptions) {
  const nodes = new Map<string, HTMLElement>();
  const tracks = new Map<string, Track>();
  const layoutCache: MonetLayoutCache = new Map();
  let words: WordNode[] = [];
  let frame = 0,
    lastFrame = 0,
    measureFrame = 0;
  let observer: ResizeObserver | undefined;
  let disposed = false;
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    lastFrame = 0;
  }
  function drawTracks(now: number) {
    frame = 0;
    const delta = lastFrame ? (now - lastFrame) / 1000 : 1 / 60;
    lastFrame = now;
    let moving = false;
    for (const track of tracks.values()) {
      if (!options.running.value || options.reducedMotion.value) {
        track.y = { value: track.targetY, velocity: 0 };
        track.scale = { value: track.targetScale, velocity: 0 };
      } else {
        const yDone = stepSpring(track.y, track.targetY, delta);
        const scaleDone = stepSpring(track.scale, track.targetScale, delta, SCALE_SPRING);
        moving ||= !yDone || !scaleDone;
      }
      track.node.style.transform = `translate3d(0, ${track.y.value}px, 0) scale(${track.scale.value})`;
    }
    if (moving && options.visible.value) frame = requestAnimationFrame(drawTracks);
    else lastFrame = 0;
  }
  function paint(timeMs: number) {
    if (!options.visible.value) return;
    const time = timeMs / 1000;
    for (const word of words) {
      if (word.status === "waiting") continue;
      const animate = options.wordAnimation() && !options.reducedMotion.value;
      const active = word.status === "active";
      const finished = word.status === "passed" || time >= word.end;
      word.body.style.color = finished
        ? "rgb(var(--monet-color))"
        : "rgba(var(--monet-color), 0.34)";
      if (active) {
        const filled = animate
          ? resolveMonetFillWidth(time, word.start, word.end, word.offsets, word.timings)
          : time >= word.start
            ? (word.offsets.at(-1) ?? 0)
            : 0;
        const end = resolveMonetSweepEnd(filled, word.offsets.at(-1) ?? 0, word.softness);
        const solid = Math.max(0, end - word.softness);
        const feather = Math.max(0, end - word.softness * 0.55);
        word.fill.style.maskImage = `linear-gradient(${word.rtl ? 270 : 90}deg, #000 0px, #000 ${solid}px, rgba(0,0,0,0.92) ${feather}px, transparent ${end}px, transparent 100%)`;
      }
      const emphasis = options.longWordEffect() || word.end - word.start < 1 ? 1 : 0.55;
      const glow = animate
        ? resolveMonetGlow(time, word.start, word.end, word.lineEnd) * emphasis
        : 0;
      word.glow.style.opacity = String(glow);
      word.glow.style.willChange = glow > 0 ? "opacity" : "auto";
    }
  }
  function measure() {
    measureFrame = 0;
    const rail = options.rail.value;
    if (disposed || !rail || !options.visible.value || !rail.clientHeight) return;
    const fontPx = options.fontSize();
    const railStyle = getComputedStyle(rail);
    const theme = stageTheme(
      railStyle.getPropertyValue("--monet-color").trim() || "239, 239, 239",
      rail,
    );
    const maxHeight = Math.max(80, rail.clientHeight - 36);
    rail.style.setProperty("--monet-available-height", `${maxHeight}px`);
    const inputs = {
      fontPx,
      translationFontPx:
        Number.parseFloat(railStyle.getPropertyValue("--monet-translation-size")) || 22,
      fontStack: theme.fontFamily ?? "sans-serif",
      translationFontStack: theme.fontFamily ?? "sans-serif",
      fontWeight: theme.fontWeight ?? 600,
      translationFontWeight: 400,
      secondaryTranslationFontWeight: 400,
      maxWidthPx: Math.max(1, rail.clientWidth - 44),
      subtitleContentMode: "both" as const,
    };
    const entries = options.entries.value.flatMap((entry) => {
      const node = nodes.get(entry.line.key);
      if (!node) return [];
      const source = { ...entry, key: entry.line.key, line: toMonetSource(entry.line) };
      const layout = measureMonetLineLayout({
        ...inputs,
        line: source.line,
        status: source.status,
      });
      // 实际 DOM 保留独立翻译/罗马音字号及语言字体，以真实内容高度覆盖原版预留高度。
      const height =
        Math.max(
          ...Array.from(node.children, (child) => {
            const element = child instanceof HTMLElement ? child : null;
            return element ? element.offsetTop + element.offsetHeight : 0;
          }),
          0,
        ) + Number.parseFloat(getComputedStyle(node).paddingBottom || "0");
      node.classList.toggle("monet-overflow", entry.status === "active" && height > maxHeight + 1);
      layout.visualHeightPx = entry.status === "active" ? Math.min(height, maxHeight) : height;
      rememberBounded(layoutCache, buildMonetLayoutCacheKey(source, inputs), layout, 240);
      return [source];
    });
    const positioned = buildPositionedEntries(
      entries,
      { width: rail.clientWidth, height: rail.clientHeight },
      theme,
      fontPx,
      fontPx * 0.72,
      inputs,
      18,
      layoutCache,
    );
    const focused = positioned.find((row) => row.offset === 0);
    const desiredY = focused
      ? clamp(
          rail.clientHeight * clamp(options.alignment(), 0.1, 0.9) - focused.scaledHeight / 2,
          18,
          Math.max(18, rail.clientHeight - focused.scaledHeight - 18),
        )
      : 0;
    const shift = focused ? desiredY - focused.y : 0;
    const retained = new Set(positioned.map((row) => row.key));
    for (const key of tracks.keys()) if (!retained.has(key)) tracks.delete(key);
    words = [];
    for (const row of positioned) {
      const node = nodes.get(row.key)!;
      const existing = tracks.get(row.key);
      const original = options.entries.value.find((entry) => entry.line.key === row.key)!;
      const tone = resolveTone(original.status, original.offset);
      const targetScale = tone.scale * (original.line.background ? 0.86 : 1);
      tracks.set(row.key, {
        node,
        y: existing?.y ?? { value: row.y + shift + (row.offset >= 0 ? 20 : -20), velocity: 0 },
        scale: existing?.scale ?? { value: targetScale, velocity: 0 },
        targetY: row.y + shift,
        targetScale,
      });
      const display = monetDisplayWords(original.line);
      node.querySelectorAll<HTMLElement>("[data-word-index]").forEach((wordNode) => {
        const word = display[Number(wordNode.dataset.wordIndex)];
        const body = wordNode.querySelector<HTMLElement>(".monet-word-body");
        const fill = wordNode.querySelector<HTMLElement>(".monet-word-fill");
        const glow = wordNode.querySelector<HTMLElement>(".monet-word-glow");
        if (!word || !body || !fill || !glow) return;
        const style = getComputedStyle(wordNode);
        const size = Number.parseFloat(style.fontSize) || fontPx;
        glow.style.textShadow = `0 0 ${Math.round(size * 0.28)}px rgba(var(--monet-color), 0.88), 0 0 ${Math.round(size * 0.65)}px rgba(var(--monet-color), 0.88)`;
        const passed = row.status === "passed";
        body.style.color = passed ? "rgb(var(--monet-color))" : "rgba(var(--monet-color), 0.34)";
        fill.style.display = row.status === "active" ? "block" : "none";
        words.push({
          node: wordNode,
          body,
          fill,
          glow,
          start: (word.glyphs[0]?.start ?? original.line.start) / 1000,
          end: (word.glyphs.at(-1)?.end ?? original.line.end) / 1000,
          lineEnd: original.line.end / 1000,
          status: row.status,
          offsets: measureMonetGraphemeOffsets(
            word.text,
            size,
            `${style.fontWeight} ${size}px ${style.fontFamily}`,
          ),
          timings: word.glyphs.map((glyph) => ({
            char: glyph.text,
            startTime: glyph.start / 1000,
            endTime: glyph.end / 1000,
          })),
          softness: resolveMonetSweepEdgeSoftness(size),
          rtl: style.direction === "rtl",
        });
      });
    }
    paint(options.clock.time.value);
    if (!frame) frame = requestAnimationFrame(drawTracks);
  }
  function scheduleMeasure() {
    if (!disposed && !measureFrame) measureFrame = requestAnimationFrame(measure);
  }
  function setLineNode(key: string, element: unknown) {
    const previous = nodes.get(key);
    if (element === previous) return;
    if (previous) observer?.unobserve(previous);
    if (element instanceof HTMLElement) {
      nodes.set(key, element);
      observer?.observe(element);
    } else nodes.delete(key);
  }
  function fontsChanged() {
    clearMonetMeasurementCaches();
    layoutCache.clear();
    scheduleMeasure();
  }
  watch(options.clock.time, paint, { flush: "post" });
  watch(
    [options.wordAnimation, options.longWordEffect, options.reducedMotion],
    () => paint(options.clock.time.value),
    { flush: "post" },
  );
  watch(options.entries, () => nextTick(scheduleMeasure), { flush: "post" });
  watch([options.visible, options.running, options.reducedMotion], () => {
    stop();
    if (options.visible.value) scheduleMeasure();
  });
  onMounted(() => {
    observer = new ResizeObserver(scheduleMeasure);
    if (options.rail.value) observer.observe(options.rail.value);
    for (const node of nodes.values()) observer.observe(node);
    document.fonts?.addEventListener("loadingdone", fontsChanged);
    void document.fonts?.ready.then(() => {
      if (!disposed) fontsChanged();
    });
    scheduleMeasure();
  });
  onBeforeUnmount(() => {
    disposed = true;
    stop();
    cancelAnimationFrame(measureFrame);
    observer?.disconnect();
    document.fonts?.removeEventListener("loadingdone", fontsChanged);
    nodes.clear();
    tracks.clear();
    layoutCache.clear();
    words = [];
  });
  return { setLineNode, scheduleMeasure };
}
