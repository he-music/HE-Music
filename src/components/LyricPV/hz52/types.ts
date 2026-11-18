// 52Hz 算法使用的局部几何、字体与只读音频契约。
export type PixiModule = typeof import("pixi.js");
export interface HzFont {
  family: string;
  weight: number;
}
export interface HzGlyph {
  char: string;
  charIndex: number;
  x: number;
  y: number;
  rotation: number;
  scale: number;
}
export interface HzLayout {
  glyphs: HzGlyph[];
  size: number;
  font: string;
}
export interface HzAudio {
  getPower(): number;
  getBands(): { bass: number; lowMid: number };
  getSpectrum(): Uint8Array | null;
}
