import { Application } from "@pixi/app";
import { Texture } from "@pixi/core";
import { Container } from "@pixi/display";
import { Sprite } from "@pixi/sprite";
import { kineticBufferSize } from "./viewport";
import {
  clamp,
  kineticCamera,
  kineticImpact,
  kineticNote,
  kineticTrail,
  type KineticLayout,
  type KineticRow,
} from "./model";

export interface KineticTypography {
  family: string;
  weight: string;
  style: string;
  size: number;
  translationSize: number;
  romanizationSize: number;
  fontRevision?: number;
}
interface PaintRow {
  root: Container;
  subtitle: Container;
  glyphs: { body: Sprite; glow: Sprite }[];
  ready: boolean;
}

/** One manually rendered Pixi scene. No ticker, per-frame text rasterization or filters. */
export class KineticScene {
  readonly app: Application;
  private world = new Container();
  private effects = new Container();
  private textures = new Map<string, Texture>();
  private rows: PaintRow[] = [];
  private layout: KineticLayout = { rows: [], targets: [], stops: [] };
  private typography: KineticTypography;
  private resolution = Math.min(window.devicePixelRatio || 1, 2);
  private note: Sprite;
  private noteGlow: Sprite;
  private ring: Sprite;
  private trail: { body: Sprite; glow: Sprite }[];
  private lastTime = -Infinity;
  private trailStart = 0;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement, typography: KineticTypography) {
    this.typography = typography;
    this.app = new Application({
      view: canvas,
      width: 1,
      height: 1,
      backgroundAlpha: 0,
      antialias: true,
      resolution: this.resolution,
      autoDensity: true,
      autoStart: false,
    });
    this.app.stage.addChild(this.world, this.effects);
    const glowTexture = this.texture("effect-glow", 64, 64, (ctx) => {
      const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, "rgba(255,255,255,0.8)");
      gradient.addColorStop(0.35, "rgba(255,255,255,0.3)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
    });
    this.trail = Array.from({ length: 24 }, () => {
      const glow = new Sprite(glowTexture);
      const body = new Sprite(Texture.WHITE);
      glow.anchor.set(0.5);
      body.anchor.set(0, 0.5);
      this.effects.addChild(glow, body);
      return { body, glow };
    });
    this.ring = new Sprite(
      this.texture("effect-ring", 144, 144, (ctx) => {
        ctx.strokeStyle = "white";
        ctx.lineWidth = 1.5;
        ctx.shadowColor = "white";
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(72, 72, 60, 0, Math.PI * 2);
        ctx.stroke();
      }),
    );
    this.noteGlow = new Sprite(glowTexture);
    this.note = new Sprite(
      this.texture("effect-note", 40, 54, (ctx) => {
        ctx.translate(20, 36);
        ctx.fillStyle = "white";
        ctx.beginPath();
        ctx.ellipse(-4, 0, 7, 5, (-24 * Math.PI) / 180, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "white";
        ctx.lineWidth = 2.7;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(2, 0);
        ctx.lineTo(2, -23);
        ctx.bezierCurveTo(3, -17, 12, -18, 10, -10);
        ctx.stroke();
      }),
    );
    this.ring.anchor.set(0.5);
    this.noteGlow.anchor.set(0.5);
    this.note.anchor.set(0.5, 36 / 54);
    this.effects.addChild(this.ring, this.noteGlow, this.note);
  }

  private texture(
    key: string,
    width: number,
    height: number,
    paint: (ctx: CanvasRenderingContext2D) => void,
  ) {
    const cached = this.textures.get(key);
    if (cached) return cached;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width * this.resolution));
    canvas.height = Math.max(1, Math.ceil(height * this.resolution));
    const ctx = canvas.getContext("2d")!;
    ctx.scale(this.resolution, this.resolution);
    paint(ctx);
    const texture = Texture.from(canvas, { resolution: this.resolution });
    this.textures.set(key, texture);
    return texture;
  }

  private text(text: string, size: number, glow = false, subtitle = false) {
    const { family, weight, style } = this.typography;
    const font = `${style} ${subtitle ? "400" : weight} ${size}px ${family}`;
    const key = `text:${font}:${glow}:${text}`;
    const cached = this.textures.get(key);
    if (cached) {
      const sprite = new Sprite(cached);
      sprite.anchor.set(0.5);
      return sprite;
    }
    const measure = document.createElement("canvas").getContext("2d")!;
    measure.font = font;
    const padding = glow ? size * 0.65 : size * 0.2;
    const width = measure.measureText(text).width + padding * 2;
    const height = size * 1.6 + padding * 2;
    const texture = this.texture(key, width, height, (ctx) => {
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "white";
      if (glow) {
        ctx.shadowColor = "white";
        ctx.shadowBlur = size * 0.35;
      }
      ctx.fillText(text, width / 2, height / 2);
    });
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    return sprite;
  }

  setLayout(layout: KineticLayout, typography: KineticTypography) {
    if (this.destroyed) return;
    this.world.removeChildren().forEach((child) => child.destroy({ children: true }));
    const sameLyrics =
      layout.rows.length === this.layout.rows.length &&
      layout.rows.every((row, index) => row.line === this.layout.rows[index].line);
    const sameTypography = JSON.stringify(typography) === JSON.stringify(this.typography);
    // Width changes can arrive every frame during the cover/pure layout transition.
    // Reuse glyph textures through that reflow instead of rasterizing them again.
    if (!sameLyrics || !sameTypography) {
      for (const [key, texture] of this.textures) {
        if (key.startsWith("text:")) {
          texture.destroy(true);
          this.textures.delete(key);
        }
      }
    }
    this.layout = layout;
    this.typography = typography;
    this.rows = layout.rows.map((row) => {
      const root = new Container();
      root.y = row.y;
      const subtitle = new Container();
      root.addChild(subtitle);
      this.world.addChild(root);
      return { root, subtitle, glyphs: [], ready: false };
    });
    this.lastTime = -Infinity;
  }

  private prepareRow(row: KineticRow, paint: PaintRow, width: number) {
    if (paint.ready) return;
    const size = this.typography.size;
    for (const glyph of row.glyphs) {
      const glow = this.text(glyph.char, size, true);
      const body = this.text(glyph.char, size);
      paint.root.addChild(glow, body);
      paint.glyphs.push({ body, glow });
    }
    row.paragraphs.forEach((text, index) => {
      const sprite = this.text(text, size);
      sprite.position.set(width / 2, index * size * 1.4);
      paint.root.addChild(sprite);
    });
    let y = row.subtitleY;
    for (const [texts, fontSize] of [
      [row.translation, this.typography.translationSize],
      [row.romanization, this.typography.romanizationSize],
    ] as const) {
      texts.forEach((text) => {
        const sprite = this.text(text, fontSize, false, true);
        sprite.position.set(width / 2, y + fontSize * 0.75);
        paint.subtitle.addChild(sprite);
        y += fontSize * 1.5;
      });
    }
    paint.ready = true;
  }

  render(
    time: number,
    width: number,
    height: number,
    color: number,
    reduced: boolean,
    browseY?: number,
  ) {
    if (this.destroyed || width <= 0 || height <= 0) return;
    const buffer = kineticBufferSize(width, height, this.resolution);
    if (this.app.view.width !== buffer.width || this.app.view.height !== buffer.height) {
      this.app.renderer.resize(buffer.width / this.resolution, buffer.height / this.resolution);
    }
    if (time < this.lastTime || time - this.lastTime > 250) this.trailStart = time;
    this.lastTime = time;
    const camera = kineticCamera(this.layout, time, reduced);
    const browsing = browseY !== undefined;
    const shift = height * 0.48 - (browseY ?? camera.y);
    this.world.y = shift;
    this.effects.y = shift;
    const size = this.typography.size;
    this.layout.rows.forEach((row, index) => {
      const paint = this.rows[index];
      const y = row.y + shift;
      // Prewarm nearby rows once, cull everything outside the viewport.
      if (y + row.height > -height && y < height * 2) this.prepareRow(row, paint, width);
      paint.root.visible = y + row.height > -size && y < height + size;
      if (!paint.root.visible) return;
      const focus =
        camera.row === camera.nextRow
          ? Number(index === camera.row)
          : index === camera.row
            ? 1 - camera.progress
            : index === camera.nextRow
              ? camera.progress
              : 0;
      const idle = y < height * 0.48 ? 0.16 : 0.28;
      paint.root.alpha = browsing ? 0.65 : idle + focus * (1 - idle);
      paint.subtitle.alpha = browsing ? 0.8 : focus * 0.8;
      // Sprite tint is cheap and keeps color changes independent of glyph textures.
      for (const child of paint.root.children) if (child instanceof Sprite) child.tint = color;
      for (const child of paint.subtitle.children) (child as Sprite).tint = color;
      row.glyphs.forEach((glyph, i) => {
        const { body, glow } = paint.glyphs[i];
        const age = time - glyph.startTime;
        const impact = age >= 0 && age < 260 ? Math.sin((age / 260) * Math.PI) : 0;
        body.position.set(glyph.x, glyph.y + impact * size * 0.12);
        body.angle = glyph.rotation;
        body.scale.set(1 + impact * 0.06);
        body.alpha = age >= 0 ? 1 : 0.48;
        glow.position.copyFrom(body.position);
        glow.angle = body.angle;
        glow.scale.copyFrom(body.scale);
        glow.alpha =
          !browsing && age >= 0 && time <= glyph.endTime
            ? 0.45 + clamp(age / Math.max(1, glyph.endTime - glyph.startTime)) * 0.45
            : 0;
      });
    });
    const pose = browsing ? null : kineticNote(this.layout, time, size, reduced);
    this.note.visible = this.noteGlow.visible = !!pose;
    if (pose) {
      this.note.position.set(pose.x, pose.y);
      this.note.angle = pose.rotation;
      this.note.scale.set(Math.max(0.65, size / 40));
      this.note.alpha = pose.opacity;
      this.noteGlow.position.copyFrom(this.note.position);
      this.noteGlow.scale.set((pose.glow * size) / 64);
      this.noteGlow.alpha = pose.opacity * 0.65;
      this.note.tint = this.noteGlow.tint = color;
    }
    const impact = browsing || reduced ? null : kineticImpact(this.layout, time);
    this.ring.visible = !!impact;
    if (impact) {
      this.ring.position.set(impact.x, impact.y);
      this.ring.scale.set(((24 + impact.progress * 92) * (size / 72)) / 60);
      this.ring.alpha = (1 - impact.progress) * 0.55;
      this.ring.tint = color;
    }
    const segments =
      !browsing && !reduced ? kineticTrail(this.layout, time, size, this.trailStart) : [];
    this.trail.forEach(({ body, glow }, index) => {
      const segment = segments[index];
      body.visible = glow.visible = !!segment;
      if (!segment) return;
      const dx = segment.x2 - segment.x1,
        dy = segment.y2 - segment.y1;
      const length = Math.hypot(dx, dy);
      body.position.set(segment.x1, segment.y1);
      body.rotation = Math.atan2(dy, dx);
      body.width = length + 0.5;
      body.height = segment.width;
      body.alpha = segment.opacity;
      glow.position.set((segment.x1 + segment.x2) / 2, (segment.y1 + segment.y2) / 2);
      glow.rotation = body.rotation;
      glow.width = length + 8;
      glow.height = segment.width + 8;
      glow.alpha = segment.opacity * 0.35;
      body.tint = glow.tint = color;
    });
    this.app.render();
    return shift;
  }

  clearTrail(time: number) {
    this.trailStart = time;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app.destroy(false, { children: true, texture: false, baseTexture: false });
    this.textures.forEach((texture) => texture.destroy(true));
    this.textures.clear();
  }
}
