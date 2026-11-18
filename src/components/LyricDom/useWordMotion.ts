import { onBeforeUnmount, watch, type Ref } from "vue";
import type { Word, WordMotionCustom, WordMotionTarget } from "./vendor/types";
import { buildGlowWordLayoutVariants } from "./vendor/components/visualizer/glowWordVariants";
import {
  getGlowWordActiveEndTime,
  getGlowWordDisplayDuration,
  resolveGlowWordRenderProfile,
} from "./vendor/components/visualizer/glowWordTiming";
import { wordGlowVariants } from "./vendor/components/visualizer/wordGlow";
import { buildWordGraphemeTimings } from "@/components/LyricPV/vendor/utils/lyrics/graphemeTiming";
import { stepSpring, type SpringValue } from "@/components/Monet/motion";
import type { StageLine } from "./model";

// Vue 只更新行结构；词与块的三态、弹簧及逐字辉光直接更新 DOM。
export interface MotionItem {
  word: Word;
  config: WordMotionCustom["config"];
  chunk?: boolean;
  guide?: "left" | "right";
}
export interface MotionOptions {
  items: MotionItem[];
  line: StageLine | null;
  color: string;
  wordAnimation: boolean;
  visible: boolean;
  rotation: boolean;
}
type Status = "waiting" | "active" | "passed";
type Axis = "x" | "y" | "scale" | "rotate" | "opacity";
const axes: Axis[] = ["x", "y", "scale", "rotate", "opacity"];
interface Track {
  node: HTMLElement;
  item: MotionItem;
  status: Status;
  states: Record<Axis, SpringValue>;
  target: WordMotionTarget;
  from: Record<Axis, number>;
  changedAt: number;
  glyphs: {
    node: HTMLElement;
    start: number;
    duration: number;
    times: number[];
    peaks: number[];
  }[];
}
export function sampleGlow(progress: number, times: number[], peaks: number[]): number {
  if (progress <= times[0]) return peaks[0];
  for (let i = 1; i < times.length; i++) {
    if (progress > times[i]) continue;
    const t = (progress - times[i - 1]) / Math.max(0.001, times[i] - times[i - 1]);
    const eased = t * t * (3 - 2 * t);
    return peaks[i - 1] + (peaks[i] - peaks[i - 1]) * eased;
  }
  return peaks.at(-1) ?? 0;
}
export function useWordMotion(
  root: Ref<HTMLElement | null>,
  clock: Readonly<Ref<number>>,
  running: Readonly<Ref<boolean>>,
  reduced: Readonly<Ref<boolean>>,
  options: () => MotionOptions,
) {
  let tracks: Track[] = [];
  let frame = 0;
  let lastFrame = 0;
  let disposed = false;
  let previousTime = clock.value;
  let pausedAt: number | null = running.value ? null : performance.now();
  const variants = buildGlowWordLayoutVariants("normal");
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    lastFrame = 0;
  }
  function write(track: Track) {
    const s = track.states;
    track.node.style.transform = `translate3d(${s.x.value}px, ${s.y.value}px, 0) scale(${s.scale.value}) rotate(${s.rotate.value}deg)`;
    track.node.style.opacity = String(s.opacity.value);
  }
  function tick(now: number) {
    frame = 0;
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.064) : 1 / 60;
    lastFrame = now;
    let moving = false;
    for (const track of tracks) {
      for (const axis of axes) {
        const target = track.target[axis] ?? (axis === "scale" || axis === "opacity" ? 1 : 0);
        const state = track.states[axis];
        if (track.status === "active" && axis !== "opacity") {
          moving =
            !stepSpring(state, target, dt, { stiffness: 200, damping: 20, mass: 1 }) || moving;
        } else {
          const duration =
            track.status === "passed" && axis === "rotate" && !track.item.chunk
              ? 5000
              : axis === "opacity" && track.status === "active"
                ? 100
                : 400;
          const progress = Math.min(1, (now - track.changedAt) / duration);
          const eased = axis === "rotate" ? progress : 1 - (1 - progress) ** 3;
          state.value = track.from[axis] + (target - track.from[axis]) * eased;
          state.velocity = 0;
          moving ||= progress < 1 && Math.abs(state.value - target) > 0.001;
        }
      }
      write(track);
    }
    if (moving && running.value && !reduced.value) frame = requestAnimationFrame(tick);
    else lastFrame = 0;
  }
  function paint(timeMs: number, reset = false) {
    const opts = options();
    if (!opts.line || !opts.visible) return;
    const profile = resolveGlowWordRenderProfile(opts.line)!;
    const time = timeMs / 1000;
    let changed = false;
    for (const track of tracks) {
      const { word } = track.item;
      const animate = opts.wordAnimation && opts.line.timed && !reduced.value;
      const start = animate ? word.startTime - profile.wordLookahead : opts.line.startTime;
      const end = animate ? getGlowWordActiveEndTime(word, profile) : opts.line.endTime;
      const status: Status = time < start ? "waiting" : time > end ? "passed" : "active";
      if (status !== track.status || reset) {
        changed = true;
        track.status = status;
        track.node.dataset.status = status;
        const custom: WordMotionCustom = {
          config: track.item.config,
          baseColor: opts.color,
          activeColor: opts.color,
          duration: getGlowWordDisplayDuration(word, profile),
          wordRevealMode: profile.wordRevealMode,
        };
        const config = track.item.config;
        track.target = !animate
          ? { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 }
          : track.item.chunk
            ? {
                x:
                  status === "waiting"
                    ? config.x + (track.item.guide === "left" ? -40 : 40)
                    : config.x,
                y: config.y,
                scale: status === "waiting" ? 0.85 : 1,
                rotate: config.rotate,
                opacity: status === "waiting" ? 0 : 1,
              }
            : variants[status](custom);
        if (!opts.rotation) track.target.rotate = 0;
        track.changedAt = performance.now();
        for (const axis of axes) {
          track.from[axis] = track.states[axis].value;
          if (reset || !running.value || reduced.value) {
            track.states[axis] = {
              value: track.target[axis] ?? (axis === "scale" || axis === "opacity" ? 1 : 0),
              velocity: 0,
            };
            track.from[axis] = track.states[axis].value;
          }
        }
        write(track);
      }
      if (track.item.chunk) continue;
      for (const glyph of track.glyphs) {
        const activeAlpha = sampleGlow(
          (time - glyph.start) / glyph.duration,
          glyph.times,
          glyph.peaks,
        );
        const tail =
          status === "passed"
            ? Math.max(0, 1 - (time - end) / (profile.wordRevealMode === "normal" ? 0.9 : 0.22))
            : 1;
        glyph.node.style.opacity = String(animate && status !== "waiting" ? activeAlpha * tail : 0);
      }
    }
    if (changed && !frame && running.value && !reduced.value) frame = requestAnimationFrame(tick);
  }
  function rebuild() {
    stop();
    if (!running.value) pausedAt = performance.now();
    const opts = options();
    const line = opts.line;
    if (disposed || !root.value || !line) {
      tracks = [];
      return;
    }
    const profile = resolveGlowWordRenderProfile(line)!;
    tracks = Array.from(root.value.querySelectorAll<HTMLElement>("[data-motion-index]")).flatMap(
      (node) => {
        const item = opts.items[Number(node.dataset.motionIndex)];
        if (!item) return [];
        const timings = buildWordGraphemeTimings(item.word);
        const duration = getGlowWordDisplayDuration(item.word, profile);
        const glyphs = Array.from(
          node.querySelectorAll<HTMLElement>(":scope > .dom-word-glow > span"),
        ).map((glyph, index) => {
          const timing = timings[index];
          const glow = wordGlowVariants.active({
            activeColor: opts.color,
            duration,
            index,
            total: timings.length,
            charStartTime: timing?.startTime,
            charEndTime: timing?.endTime,
            wordStartTime: item.word.startTime,
            wordRevealMode: profile.wordRevealMode,
          });
          glyph.style.textShadow = glow.textShadow ?? "none";
          glyph.style.color = "transparent";
          return {
            node: glyph,
            start: item.word.startTime - profile.wordLookahead + (glow.transition.delay ?? 0),
            duration: glow.transition.duration,
            times: glow.transition.times ?? [0, 1],
            peaks: Array.isArray(glow.opacity) ? glow.opacity : [glow.opacity, glow.opacity],
          };
        });
        return [
          {
            node,
            item,
            status: "waiting" as Status,
            states: {
              x: { value: 0, velocity: 0 },
              y: { value: 0, velocity: 0 },
              scale: { value: 0.5, velocity: 0 },
              rotate: { value: 0, velocity: 0 },
              opacity: { value: 0, velocity: 0 },
            },
            target: {},
            from: { x: 0, y: 0, scale: 0.5, rotate: 0, opacity: 0 },
            changedAt: performance.now(),
            glyphs,
          },
        ];
      },
    );
    paint(clock.value, true);
  }
  watch([root, () => options()], rebuild, { flush: "post" });
  watch(
    clock,
    (time) => {
      const seek = Math.abs(time - previousTime) > 500;
      previousTime = time;
      paint(time, seek);
    },
    { flush: "sync" },
  );
  watch([running, reduced], () => {
    stop();
    const now = performance.now();
    if (running.value && pausedAt !== null) {
      for (const track of tracks) track.changedAt += now - pausedAt;
      pausedAt = null;
    } else if (!running.value && pausedAt === null) pausedAt = now;
    paint(clock.value, reduced.value);
    if (running.value && !reduced.value && !frame) frame = requestAnimationFrame(tick);
  });
  onBeforeUnmount(() => {
    disposed = true;
    stop();
    tracks = [];
  });
}
