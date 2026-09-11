import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import {
  clamp,
  resolveGlow,
  resolveTone,
  SCALE_SPRING,
  stepSpring,
  type SpringValue,
} from "./motion";
import type { LineStatus, MonetLine } from "./model";

// src/components/Monet/useMonetMotion.ts — 测量只在布局改变时执行，逐帧仅写入文字扫光和 transform。
export interface RailEntry {
  line: MonetLine;
  index: number;
  offset: number;
  status: LineStatus;
}
interface Track {
  node: HTMLElement;
  entry: RailEntry;
  y: SpringValue;
  scale: SpringValue;
  targetY: number;
  targetScale: number;
}
interface GlyphNode {
  node: HTMLElement;
  start: number;
  end: number;
  line: MonetLine;
  status: LineStatus;
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
  let glyphs: GlyphNode[] = [];
  let frame = 0;
  let lastFrame = 0;
  let measureFrame = 0;
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
      const snap = !options.running.value || options.reducedMotion.value;
      if (snap) {
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
  function paint(time: number) {
    if (!options.visible.value) return;
    for (const glyph of glyphs) {
      const active = glyph.status === "active";
      const progress =
        glyph.status === "passed"
          ? 1
          : !active || time < glyph.start
            ? 0
            : !options.wordAnimation() || options.reducedMotion.value || glyph.end <= glyph.start
              ? 1
              : clamp((time - glyph.start) / (glyph.end - glyph.start));
      const glow =
        options.wordAnimation() && !options.reducedMotion.value && glyph.status !== "waiting"
          ? resolveGlow(time, glyph.start, glyph.end, glyph.line.end)
          : 0;
      glyph.node.style.setProperty("--fill", `${progress * 112}%`);
      const isLong = Number(glyph.node.dataset.wordDuration) >= 1000;
      const emphasis = options.longWordEffect() && isLong ? 1 : 0.55;
      glyph.node.style.setProperty("--glow", `${glow * 0.62 * emphasis}`);
    }
  }

  /** 读取浏览器真实换行高度后，围绕当前锚点布置固定 transform 轨道。 */
  function measure() {
    measureFrame = 0;
    const rail = options.rail.value;
    if (disposed || !rail || !options.visible.value || !rail.clientHeight) return;
    rail.style.setProperty("--monet-available-height", `${Math.max(80, rail.clientHeight - 36)}px`);
    const entries = options.entries.value;
    const positioned = entries.flatMap((entry) => {
      const node = nodes.get(entry.line.key);
      if (!node) return [];
      // 扫光伪元素的上下留白也计入 scrollHeight；只用实际文字块判断溢出。
      const contentBottom = Math.max(
        0,
        ...Array.from(node.children, (child) => {
          const element = child as HTMLElement;
          return element.offsetTop + element.offsetHeight;
        }),
      );
      const paddingBottom = parseFloat(getComputedStyle(node).paddingBottom) || 0;
      node.classList.toggle(
        "monet-overflow",
        entry.status === "active" && contentBottom + paddingBottom > node.clientHeight + 1,
      );
      const tone = resolveTone(entry.status, entry.offset);
      if (entry.line.background) tone.scale *= 0.86;
      return [{ entry, node, tone, height: node.offsetHeight * tone.scale, y: 0 }];
    });
    if (!positioned.length) {
      tracks.clear();
      glyphs = [];
      stop();
      return;
    }
    const anchor = Math.max(
      0,
      positioned.findIndex((row) => row.entry.offset === 0),
    );
    const focused = positioned[anchor];
    const margin = 18;
    const focusY = rail.clientHeight * clamp(options.alignment(), 0.1, 0.9);
    focused.y = clamp(
      focusY - focused.height / 2,
      margin,
      Math.max(margin, rail.clientHeight - focused.height - margin),
    );
    const gap = (a: typeof focused, b: typeof focused) =>
      Math.max(
        14,
        options.fontSize() *
          (a.entry.status === "active" || b.entry.status === "active" ? 0.49 : 0.38),
      );
    for (let i = anchor + 1; i < positioned.length; i++) {
      const prev = positioned[i - 1];
      positioned[i].y = prev.y + prev.height + gap(prev, positioned[i]);
    }
    for (let i = anchor - 1; i >= 0; i--) {
      const next = positioned[i + 1];
      positioned[i].y = next.y - positioned[i].height - gap(positioned[i], next);
    }
    const retained = new Set(positioned.map((row) => row.entry.line.key));
    for (const key of tracks.keys()) if (!retained.has(key)) tracks.delete(key);
    glyphs = [];
    for (const row of positioned) {
      const existing = tracks.get(row.entry.line.key);
      tracks.set(row.entry.line.key, {
        node: row.node,
        entry: row.entry,
        y: existing?.y ?? { value: row.y + (row.entry.offset >= 0 ? 20 : -20), velocity: 0 },
        scale: existing?.scale ?? { value: row.tone.scale, velocity: 0 },
        targetY: row.y,
        targetScale: row.tone.scale,
      });
      row.node.querySelectorAll<HTMLElement>("[data-glyph-start]").forEach((node) => {
        glyphs.push({
          node,
          start: Number(node.dataset.glyphStart),
          end: Number(node.dataset.glyphEnd),
          line: row.entry.line,
          status: row.entry.status,
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
    document.fonts?.addEventListener("loadingdone", scheduleMeasure);
    document.fonts?.ready.then(() => {
      if (!disposed) scheduleMeasure();
    });
    scheduleMeasure();
  });
  onBeforeUnmount(() => {
    disposed = true;
    stop();
    cancelAnimationFrame(measureFrame);
    observer?.disconnect();
    document.fonts?.removeEventListener("loadingdone", scheduleMeasure);
    nodes.clear();
    tracks.clear();
    glyphs = [];
  });
  return { setLineNode, scheduleMeasure };
}
