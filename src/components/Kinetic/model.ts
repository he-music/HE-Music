import type { PartitaLine, PartitaGraphemeTiming } from "../Partita/model";

export interface KineticGlyph extends PartitaGraphemeTiming {
  x: number;
  y: number;
  width: number;
  rotation: number;
}
export interface KineticRow {
  line: PartitaLine;
  y: number;
  height: number;
  glyphs: KineticGlyph[];
  paragraphs: string[];
  translation: string[];
  romanization: string[];
  subtitleY: number;
}
interface Target {
  x: number;
  y: number;
  start: number;
  end: number;
  animated: boolean;
  disconnectAfter?: boolean;
}
interface Stop {
  time: number;
  moveStart: number;
  y: number;
  row: number;
}
export interface KineticLayout {
  rows: KineticRow[];
  targets: Target[];
  stops: Stop[];
}
export const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => {
  const p = clamp(n);
  return p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
};

/** Keep joining scripts shaped by the browser as complete paragraphs. */
const needsShaping = /[\u0590-\u109f\u1780-\u17ff]/;

export function buildKineticLayout(
  lines: PartitaLine[],
  width: number,
  fontSize: number,
  measure: (text: string, size: number) => number,
  options: {
    animate: boolean;
    translationSize: number;
    romanizationSize: number;
    showTranslation: boolean;
    showRomanization: boolean;
  },
): KineticLayout {
  const available = Math.max(1, width - 64);
  const rows: KineticRow[] = [];
  const targets: Target[] = [];
  const stops: Stop[] = [];
  // Paragraphs retain grapheme clusters, including emoji and combining marks.
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  function wrap(text: string, size: number) {
    const result: string[] = [];
    let current = "";
    for (const { segment } of segmenter.segment(text)) {
      if (current && measure(current + segment, size) > available) {
        result.push(current);
        current = "";
      }
      current += segment;
    }
    if (current) result.push(current);
    return result;
  }
  let bottom = 0;
  let previousOnset = -Infinity;
  for (const [index, line] of lines.entries()) {
    const animated =
      options.animate && line.timed && !line.isInterlude && !needsShaping.test(line.fullText);
    const glyphs: KineticGlyph[] = [];
    const paragraphs = animated ? [] : wrap(line.fullText, fontSize);
    const translation = options.showTranslation
      ? wrap(line.translation, options.translationSize)
      : [];
    const romanization = options.showRomanization
      ? wrap(line.romanization, options.romanizationSize)
      : [];
    let baseline = 0;
    if (animated) {
      let chunk: KineticGlyph[] = [];
      let used = 0;
      const flush = () => {
        const left = (width - used) / 2;
        for (const glyph of chunk) glyph.x += left;
        chunk = [];
        used = 0;
      };
      for (const [i, source] of line.words.flatMap((word) => word.graphemes).entries()) {
        const glyphWidth = Math.max(1, measure(source.char, fontSize));
        if (chunk.length && used + glyphWidth > available) {
          flush();
          baseline += fontSize * 1.75;
        }
        const wave = Math.sin(i * 0.65);
        const glyph = {
          ...source,
          x: used + glyphWidth / 2,
          y: baseline + wave * fontSize * 0.22,
          width: glyphWidth,
          rotation: Math.cos(i * 0.65) * 7,
        };
        chunk.push(glyph);
        glyphs.push(glyph);
        used += glyphWidth + fontSize * 0.025;
      }
      flush();
    }
    const mainHeight = animated
      ? baseline + fontSize * 1.5
      : Math.max(1, paragraphs.length) * fontSize * 1.4;
    const subtitleY = mainHeight + 12;
    const height =
      subtitleY +
      translation.length * options.translationSize * 1.5 +
      romanization.length * options.romanizationSize * 1.5;
    const y = bottom + fontSize * 0.75;
    rows.push({ line, y, height, glyphs, paragraphs, translation, romanization, subtitleY });
    let lastBaseline = -Infinity;
    const addStop = (time: number, offset: number) =>
      stops.push({
        time,
        moveStart: Math.max(previousOnset, time - 650),
        y: y + offset,
        row: index,
      });
    if (animated) {
      for (const [i, glyph] of glyphs.entries()) {
        if (!glyph.char.trim()) continue;
        const rowY = glyph.y - Math.sin(i * 0.65) * fontSize * 0.22;
        if (Math.abs(rowY - lastBaseline) > 1) {
          if (!line.isInterlude) addStop(glyph.startTime, rowY);
          lastBaseline = rowY;
        }
        previousOnset = glyph.startTime;
        targets.push({
          x: glyph.x,
          y: y + glyph.y - fontSize * 0.85,
          start: glyph.startTime,
          end: glyph.endTime,
          animated: true,
        });
      }
    } else {
      if (!line.isInterlude) addStop(line.startTime, 0);
      previousOnset = line.startTime;
      if (!line.isInterlude)
        targets.push({
          x: Math.max(16, (width - measure(paragraphs[0] || "", fontSize)) / 2 - 20),
          y,
          start: line.startTime,
          end: line.endTime,
          animated: false,
        });
    }
    bottom = y + height + fontSize * 1.1;
  }
  // Duets/background vocals can overlap and supply non-monotonic word onsets.
  targets.sort((a, b) => a.start - b.start);
  targets.forEach((target, index) => {
    const next = targets[index + 1];
    target.disconnectAfter =
      !!next &&
      rows.some(
        ({ line }) =>
          line.isInterlude && line.startTime >= target.end && line.startTime < next.start,
      );
  });
  stops.sort((a, b) => a.time - b.time);
  for (let i = 1; i < stops.length; i++)
    stops[i].moveStart = Math.min(stops[i].time, Math.max(stops[i - 1].time, stops[i].moveStart));
  return { rows, targets, stops };
}

function preceding<T>(items: T[], time: number, start: (item: T) => number) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (start(items[mid]) <= time) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

export function kineticCamera(layout: KineticLayout, time: number, reduced = false) {
  const i = Math.max(
    0,
    preceding(layout.stops, time, (stop) => stop.time),
  );
  const current = layout.stops[i];
  if (!current) return { y: 0, row: -1, nextRow: -1, progress: 0 };
  const next = layout.stops[i + 1];
  const progress =
    next && !reduced ? ease((time - next.moveStart) / Math.max(1, next.time - next.moveStart)) : 0;
  return {
    y: current.y + ((next?.y ?? current.y) - current.y) * progress,
    row: current.row,
    nextRow: next?.row ?? current.row,
    progress,
  };
}

export function kineticImpact(layout: KineticLayout, time: number) {
  const i = preceding(layout.targets, time, (target) => target.start);
  if (i < 0) return null;
  const target = layout.targets[i];
  const elapsed = time - target.start;
  if (!target.animated || elapsed < 0 || elapsed >= 640) return null;
  return {
    x: target.x,
    y: target.y,
    progress: elapsed / 640,
  };
}

export function kineticNote(
  layout: KineticLayout,
  time: number,
  fontSize: number,
  reduced = false,
) {
  const i = preceding(layout.targets, time, (target) => target.start);
  if (i < 0) return null;
  const current = layout.targets[i];
  const next = layout.targets[i + 1];
  let sustainEnd = current.end;
  // Like the reference HTML, adjacent landing points form one continuous flight.
  // Only an actual instrumental interlude interrupts the path. Keep long held
  // syllables stationary until takeoff, without fading before the flight starts.
  if (next && !reduced && !current.disconnectAfter) {
    const start =
      next.start - current.start > 1600
        ? Math.max(current.start, Math.min(current.end, next.start - 650))
        : current.start;
    sustainEnd = start;
    if (time >= start) {
      const p = clamp((time - start) / Math.max(1, next.start - start));
      const animated = current.animated || next.animated;
      const travel = animated ? p : ease(p);
      const arc = fontSize * 0.55 + Math.hypot(next.x - current.x, next.y - current.y) * 0.36;
      const lift = animated ? arc * 4 * p * (1 - p) : 0;
      return {
        x: current.x + (next.x - current.x) * travel,
        y: current.y + (next.y - current.y) * travel - lift,
        rotation:
          animated && p > 0 ? Math.sin(p * Math.PI) * 13 * Math.sign(next.x - current.x) : 0,
        opacity: 1,
        glow: animated ? 0.55 + 4 * p * (1 - p) * 0.7 : 1,
      };
    }
  }
  const opacity = 1 - clamp((time - sustainEnd) / 650);
  if (!opacity) return null;
  const age = time - current.start;
  const envelope = ease(age / 280) * ease((sustainEnd - time) / 280);
  const glow = reduced
    ? 1
    : 1 + (0.5 - 0.5 * Math.cos((age / 1600) * Math.PI * 2)) * 0.25 * envelope;
  return { x: current.x, y: current.y, rotation: 0, opacity, glow };
}

/** Reconstruct the last 360ms in world coordinates; clear history after seeks. */
export function kineticTrail(
  layout: KineticLayout,
  time: number,
  fontSize: number,
  since = -Infinity,
) {
  const segments: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    opacity: number;
    width: number;
  }[] = [];
  let previous: ReturnType<typeof kineticNote> = null;
  for (let step = 0; step <= 24; step++) {
    const sampleTime = time - 360 + step * 15;
    const point = sampleTime >= since ? kineticNote(layout, sampleTime, fontSize) : null;
    if (point && previous && Math.hypot(point.x - previous.x, point.y - previous.y) > 0.01) {
      const freshness = step / 24;
      segments.push({
        x1: previous.x,
        y1: previous.y,
        x2: point.x,
        y2: point.y,
        opacity: freshness * 0.72 * Math.min(previous.opacity, point.opacity),
        width: 0.4 + freshness * 3.6,
      });
    }
    previous = point;
  }
  return segments;
}
