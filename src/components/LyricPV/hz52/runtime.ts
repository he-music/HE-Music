import type { Application } from "pixi.js";
import type { PVSong, PVRuntime, PVRuntimeOptions } from "../runtime";
import { fitPVProfile } from "../viewport";
import { loadPixi } from "../vendor/components/visualizer/pixi/loadPixi";
import { resolveThemeFontStack, resolveThemeFontWeight } from "../vendor/utils/fontStacks";
import { layoutLine, buildLineField } from "../vendor/mods/visualizer52hz/lineLayout";
import { buildPithField } from "../vendor/mods/visualizer52hz/pithShape";
import { createLyricText } from "../vendor/mods/visualizer52hz/lyricText";
import { hashString } from "../vendor/mods/visualizer52hz/random";
import {
  SLOT_COUNT,
  createFieldSource,
  createHistorySource,
  createRippleFilter,
} from "../vendor/mods/visualizer52hz/rippleFilter";
import { Hz52History } from "./history";
import { find52HzLineIndex } from "./source";
import { release52HzFields } from "./resources";
import type { HzAudio, PixiModule } from "./types";

// 将原版 stage.mjs 的四槽字形场接到共享 Vue 宿主，保留年轮与逐字点亮算法。
type RingSource =
  { key: string; kind: "line"; lineIndex: number } | { key: string; kind: "pith"; seed: number };
const WINDOWS = ["uWindow0", "uWindow1", "uWindow2", "uWindow3"] as const;
const UNUSED_WINDOW = [1, 0];
const OPEN_WINDOW_END = 1e9;

export async function create52HzRuntime(options: PVRuntimeOptions): Promise<PVRuntime> {
  const pixi = await loadPixi();
  if (options.signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const app = new pixi.Application();
  try {
    await app.init({
      width: Math.max(1, options.host.clientWidth),
      height: Math.max(1, options.host.clientHeight),
      backgroundAlpha: 0,
      antialias: false,
      preference: "webgl",
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      autoStart: false,
      sharedTicker: false,
    });
  } catch (error) {
    if (app.renderer) app.destroy(true, { children: true });
    throw error;
  }
  if (options.signal.aborted) {
    app.destroy(true, { children: true });
    throw new DOMException("Cancelled", "AbortError");
  }
  let runtime: Hz52Runtime | undefined;
  try {
    runtime = new Hz52Runtime(pixi, app, options);
    runtime.install();
    return runtime;
  } catch (error) {
    if (runtime) runtime.destroy();
    else app.destroy(true, { children: true });
    throw error;
  }
}

class Hz52Runtime implements PVRuntime {
  private song: PVSong;
  private paused: boolean;
  private reduced: boolean;
  private disposed = false;
  private frame: number | undefined;
  private observer: ResizeObserver | undefined;
  private width = 1;
  private height = 1;
  private cell = 4;
  private gridWidth = 1;
  private gridHeight = 1;
  private songSeed = 0;
  private hasLyrics = false;
  private readonly history = new Hz52History();
  private readonly historySource;
  private readonly beatSource;
  private readonly ringSprite;
  private readonly text;
  private readonly audio: HzAudio;
  private fields: ReturnType<typeof createFieldSource>[] = [];
  private ring: ReturnType<typeof createRippleFilter> | undefined;
  private readonly slots: { source: RingSource | null; start: number; end: number }[] = Array.from(
    { length: SLOT_COUNT },
    () => ({ source: null, start: 1, end: 0 }),
  );
  private openSlot = -1;
  private shownKey: string | null | undefined;
  private dirty = true;
  private renderedTime: number | null = null;
  private clockTime: number | null = null;
  private staticTime = 0;
  private lastGlyphKey = "";

  constructor(
    private readonly pixi: PixiModule,
    private readonly app: Application,
    private readonly options: PVRuntimeOptions,
  ) {
    this.song = options.song;
    this.paused = options.paused;
    this.reduced = options.reduced;
    this.historySource = createHistorySource(pixi);
    this.historySource.resource = this.history.energy;
    this.beatSource = createHistorySource(pixi);
    this.beatSource.resource = this.history.beats;
    this.ringSprite = new pixi.Sprite(pixi.Texture.WHITE);
    const textLayer = new pixi.Container();
    this.app.stage.addChild(this.ringSprite, textLayer);
    this.text = createLyricText(pixi, textLayer);
    this.audio = {
      getPower: () => options.audioPower.get(),
      getBands: () => ({
        bass: options.audioBands.bass.get(),
        lowMid: options.audioBands.mid.get(),
      }),
      getSpectrum: () => options.audioSpectrum?.() ?? null,
    };
  }

  install() {
    this.app.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    this.options.host.appendChild(this.app.canvas);
    this.updateSongIdentity();
    this.rebuildGeometry();
    this.lastGlyphKey = this.glyphKey();
    if (this.reduced) this.history.seedStatic();
    this.observer = new ResizeObserver(() => {
      if (this.disposed) return;
      if (
        this.options.host.clientWidth !== this.width ||
        this.options.host.clientHeight !== this.height
      ) {
        this.rebuildGeometry();
        this.renderOnce();
      }
    });
    this.observer.observe(this.options.host);
    this.renderOnce();
  }

  private updateSongIdentity() {
    this.hasLyrics = this.song.lines.some((line) => line.fullText.trim());
    this.songSeed = hashString(this.song.seed);
  }

  private glyphKey() {
    const theme = this.song.theme;
    return `${resolveThemeFontStack(theme)}|${theme.fontWeight}|${theme.primaryColor}|${theme.accentColor}|${theme.lyricSafeArea?.top}|${theme.lyricSafeArea?.bottom}`;
  }

  private layoutFor(index: number) {
    const line = this.song.lines[index];
    if (!line?.fullText.trim()) return null;
    const { region } = fitPVProfile({ region: { cx: 0.5, cy: 0.5, w: 1, h: 1 } }, this.song.theme);
    const layout = layoutLine(
      line.fullText,
      {
        family: resolveThemeFontStack(this.song.theme),
        weight: resolveThemeFontWeight(this.song.theme, 500),
      },
      this.width,
      this.height * region.h,
      1,
    );
    const top = this.height * (region.cy - region.h / 2);
    for (const glyph of layout.glyphs) glyph.y += top;
    return layout;
  }

  private sourceAt(time: number): RingSource | null {
    if (!this.hasLyrics) {
      const period = Math.floor(time / 11);
      return {
        key: `pith:${period}`,
        kind: "pith",
        seed: (this.songSeed ^ Math.imul(period + 1, 0x9e3779b1)) >>> 0,
      };
    }
    const lineIndex = find52HzLineIndex(this.song.lines, time);
    return lineIndex < 0 ? null : { key: `line:${lineIndex}`, kind: "line", lineIndex };
  }

  private fillField(index: number) {
    const target = this.fields[index];
    const source = this.slots[index].source;
    if (source?.kind === "line") {
      const layout = this.layoutFor(source.lineIndex);
      if (layout)
        target.resource = buildLineField(layout, this.cell, this.gridWidth, this.gridHeight);
      else target.resource.fill(1e6);
    } else if (source?.kind === "pith") {
      target.resource = buildPithField(
        source.seed,
        this.width,
        this.height,
        this.cell,
        this.gridWidth,
        this.gridHeight,
      );
    } else target.resource.fill(1e6);
    target.update();
  }

  private applyWindows() {
    const ring = this.ring;
    if (!ring) return;
    this.slots.forEach((slot, index) => {
      const range = ring.uniforms[WINDOWS[index]];
      const used = slot.source !== null && slot.end >= slot.start;
      range[0] = used ? slot.start : UNUSED_WINDOW[0];
      range[1] = used ? slot.end : UNUSED_WINDOW[1];
    });
  }

  private switchSource(source: RingSource | null, time: number) {
    this.shownKey = source?.key ?? null;
    if (this.openSlot >= 0) this.slots[this.openSlot].end = time;
    this.openSlot = -1;
    this.text.hide(time);
    this.staticTime =
      source?.kind === "line"
        ? this.song.lines[source.lineIndex].startTime + 3.6
        : Math.floor(time / 11) * 11 + 3.6;
    if (!source) return;
    let target = this.slots.findIndex((slot) => slot.source === null);
    if (target < 0)
      target = this.slots.reduce(
        (oldest, slot, index) => (slot.end < this.slots[oldest].end ? index : oldest),
        0,
      );
    this.slots[target] = { source, start: this.reduced ? -1e9 : time, end: OPEN_WINDOW_END };
    this.openSlot = target;
    this.fillField(target);
    if (source.kind === "line") {
      const layout = this.layoutFor(source.lineIndex);
      if (layout)
        this.text.show(
          this.song.lines[source.lineIndex],
          source.lineIndex,
          layout,
          this.song.theme,
          this.app.renderer.resolution,
          time,
        );
    }
  }

  private resetSources(time: number) {
    this.slots.forEach((slot, index) => {
      if (index === this.openSlot) slot.start = time;
      else Object.assign(slot, { source: null, start: 1, end: 0 });
    });
    this.text.restart(time);
    this.applyWindows();
    this.dirty = true;
  }

  private rebuildGeometry() {
    this.width = Math.max(1, this.options.host.clientWidth);
    this.height = Math.max(1, this.options.host.clientHeight);
    this.app.renderer.resize(this.width, this.height);
    this.cell = Math.max(2, Math.max(this.width, this.height) / 480);
    this.gridWidth = Math.ceil(this.width / this.cell);
    this.gridHeight = Math.ceil(this.height / this.cell);
    release52HzFields(this.ringSprite, this.ring?.filter, this.fields);
    this.fields = Array.from({ length: SLOT_COUNT }, () =>
      createFieldSource(this.pixi, this.gridWidth, this.gridHeight),
    );
    this.ring = createRippleFilter(this.pixi, {
      fieldSources: this.fields,
      historySource: this.historySource,
      beatSource: this.beatSource,
    });
    this.ringSprite.filters = [this.ring.filter];
    this.ringSprite.filterArea = this.app.screen;
    this.ringSprite.width = this.width;
    this.ringSprite.height = this.height;
    this.ring.uniforms.uScreen.set([this.width, this.height]);
    this.ring.uniforms.uCell = this.cell;
    this.slots.forEach((_, index) => this.fillField(index));
    this.applyWindows();
    const index = this.text.lineIndex;
    const layout = this.layoutFor(index);
    if (layout)
      this.text.rebuild(
        this.song.lines[index],
        layout,
        this.song.theme,
        this.app.renderer.resolution,
      );
    this.applyLook();
    this.dirty = true;
  }

  private applyLook() {
    if (!this.ring) return;
    const halfDiagonal = Math.hypot(this.width, this.height) / 2;
    this.ring.uniforms.uSpeed = halfDiagonal / 10;
    this.ring.uniforms.uFadeDistance = halfDiagonal;
    this.ring.uniforms.uOpacity = 0.8;
    this.ring.uniforms.uColorNear.set(
      new this.pixi.Color(this.song.theme.accentColor).toRgbArray(),
    );
    this.ring.uniforms.uColorFar.set(
      new this.pixi.Color(this.song.theme.primaryColor).toRgbArray(),
    );
  }

  private tick() {
    if (!this.ring || this.disposed) return false;
    const time = Math.max(0, this.options.currentTime.get());
    if (!this.reduced) {
      if (!this.paused) {
        const update = this.history.step(time, performance.now(), this.audio);
        if (update === "reset") this.resetSources(time);
        if (update !== "idle") {
          this.historySource.update();
          this.beatSource.update();
        }
      } else if (this.clockTime !== null && time !== this.clockTime) {
        this.history.reset(time);
        this.historySource.update();
        this.beatSource.update();
        this.resetSources(time);
      }
    }
    this.clockTime = time;
    const source = this.sourceAt(time);
    if ((source?.key ?? null) !== this.shownKey) {
      this.switchSource(source, time);
      this.applyWindows();
      this.dirty = true;
    }
    const drawTime = this.reduced ? this.staticTime : time;
    if (!this.dirty && drawTime === this.renderedTime) return false;
    const fading = this.text.update(time, this.reduced);
    this.ring.uniforms.uTime = drawTime;
    this.ring.uniforms.uHistoryStart = this.history.start;
    this.app.render();
    this.renderedTime = drawTime;
    this.dirty = fading;
    return fading;
  }

  private schedule(fading: boolean) {
    if (this.disposed || this.frame !== undefined || (this.paused && !fading)) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.schedule(this.tick());
    });
  }

  async swapSong(song: PVSong, signal: AbortSignal) {
    if (this.disposed || signal.aborted) return;
    const changed = song.seed !== this.song.seed || song.lines !== this.song.lines;
    this.song = song;
    const time = Math.max(0, this.options.currentTime.get());
    if (changed) {
      this.updateSongIdentity();
      this.openSlot = -1;
      this.shownKey = undefined;
      this.text.hide(time);
      this.history.reset(time);
      this.resetSources(time);
      if (this.reduced) this.history.seedStatic();
      this.historySource.update();
      this.beatSource.update();
    }
    const key = this.glyphKey();
    if (
      key !== this.lastGlyphKey ||
      this.options.host.clientWidth !== this.width ||
      this.options.host.clientHeight !== this.height
    ) {
      this.lastGlyphKey = key;
      this.rebuildGeometry();
    } else this.applyLook();
    this.renderOnce();
  }

  setPaused(paused: boolean) {
    if (this.disposed || this.paused === paused) return;
    // 先消费暂停前最后一帧的时钟，避免把正常推进误判成暂停后的跳转。
    if (paused) this.tick();
    this.paused = paused;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (!paused)
      this.history.synchronize(Math.max(0, this.options.currentTime.get()), performance.now());
    this.renderOnce();
  }

  setStaticMode(reduced: boolean) {
    if (this.disposed || this.reduced === reduced) return;
    this.reduced = reduced;
    const time = Math.max(0, this.options.currentTime.get());
    this.history.reset(time);
    if (reduced) this.history.seedStatic();
    this.historySource.update();
    this.beatSource.update();
    this.openSlot = -1;
    this.shownKey = undefined;
    this.resetSources(time);
    this.renderOnce();
  }
  seek() {
    if (this.disposed) return;
    const time = Math.max(0, this.options.currentTime.get());
    this.history.reset(time);
    if (this.reduced) this.history.seedStatic();
    this.historySource.update();
    this.beatSource.update();
    this.resetSources(time);
    this.clockTime = time;
    this.renderOnce();
  }

  renderOnce() {
    if (this.disposed) return;
    this.dirty = true;
    this.schedule(this.tick());
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.text.destroy();
    release52HzFields(this.ringSprite, this.ring?.filter, this.fields);
    this.ringSprite.removeFromParent();
    this.ringSprite.destroy();
    this.historySource.destroy();
    this.beatSource.destroy();
    this.app.destroy(true, { children: true });
  }
}
