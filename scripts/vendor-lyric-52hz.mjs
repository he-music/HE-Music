import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

// 固定原版 52Hz 算法，补充类型并接到共享的字形时序；Vue 与运行时适配单独维护。
const revision = "a8885a87539b92fb1149fc58ef0f033ad65ec042";
const upstream = process.argv[2];
if (!upstream) throw new Error("用法：node scripts/vendor-lyric-52hz.mjs <folia-major 仓库路径>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const formatting = await resolveConfig(resolve(root, "package.json"));
const changes = {
  random: [
    ["(text) =>", "(text: string) =>"],
    ["(seed) =>", "(seed: number) =>"],
    ["(random, min, max) =>", "(random: () => number, min: number, max: number) =>"],
  ],
  distanceField: [
    [
      "(f, n, d, v, z) =>",
      "(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) =>",
    ],
    ["(alpha, width, height) =>", "(alpha: Uint8Array, width: number, height: number) =>"],
  ],
  pithShape: [
    ["(seed, width, height) =>", "(seed: number, width: number, height: number) =>"],
    ["const points = [];", "const points: [number, number][] = [];"],
    [
      "(seed, width, height, cell, gridWidth, gridHeight) =>",
      "(seed: number, width: number, height: number, cell: number, gridWidth: number, gridHeight: number) =>",
    ],
  ],
  beatDetector: [
    ["let previousBins = null;", "let previousBins: Float32Array | null = null;"],
    ["(audio) =>", "(audio: HzAudio) =>"],
    [
      "step(audio, time, dt, sensitivity)",
      "step(audio: HzAudio | null, time: number, dt: number, sensitivity: number)",
    ],
  ],
  lineLayout: [
    ["(font, size) =>", "(font: HzFont, size: number) =>"],
    ["(chars) =>", "(chars: string[]) =>"],
    ["const tokens = [];", "const tokens: CharEntry[][] = [];"],
    ["let current = [];", "let current: CharEntry[] = [];"],
    ["(row) =>", "(row: MeasuredEntry[]) =>"],
    ["(tokens, maxWidth) =>", "(tokens: MeasuredEntry[][], maxWidth: number) =>"],
    ["const rows = [];", "const rows: MeasuredEntry[][] = [];"],
    ["let row = [];", "let row: MeasuredEntry[] = [];"],
    [
      "(text, font, width, height, fontScale) =>",
      "(text: string, font: HzFont, width: number, height: number, fontScale: number): HzLayout =>",
    ],
    ["const chars = Array.from(text);", "const chars = splitLyricGraphemes(text);"],
    ["let rows = [];", "let rows: MeasuredEntry[][] = [];"],
    ["const glyphs = [];", "const glyphs: HzGlyph[] = [];"],
    [
      "let word = null;",
      "let word: { dy: number; rotation: number; scale: number } | null = null;",
    ],
    [
      "(ctx, glyph, stroke) =>",
      "(ctx: CanvasRenderingContext2D, glyph: HzGlyph, stroke: boolean) =>",
    ],
    [
      "(glyph, layout, dpr, color, glow) =>",
      "(glyph: HzGlyph, layout: HzLayout, dpr: number, color: string, glow: string | null) =>",
    ],
    [
      "(layout, cell, gridWidth, gridHeight) =>",
      "(layout: HzLayout, cell: number, gridWidth: number, gridHeight: number) =>",
    ],
  ],
  lyricText: [
    ["from './charTimings.mjs'", "from '../../../hz52/timing'"],
    ["(t) =>", "(t: number) =>"],
    ["(time, songStart, wallStart) =>", "(time: number, songStart: number, wallStart: number) =>"],
    [
      "(PIXI, canvas, side, dpr) =>",
      "(PIXI: PixiModule, canvas: HTMLCanvasElement, side: number, dpr: number) =>",
    ],
    ["(PIXI, layer) =>", "(PIXI: PixiModule, layer: Container) =>"],
    ["let current = null;", "let current: ReturnType<typeof build> | null = null;"],
    [
      "const fading = [];",
      "const fading: { container: Container; hiddenAt: number; hiddenAtWall: number }[] = [];",
    ],
    ["(container) =>", "(container: Container) =>"],
    [
      "(line, lineIndex, layout, theme, dpr, shownAt, shownAtWall) =>",
      "(line: Line, lineIndex: number, layout: HzLayout, theme: Theme, dpr: number, shownAt: number, shownAtWall: number) =>",
    ],
    [
      "show(line, lineIndex, layout, theme, dpr, time)",
      "show(line: Line, lineIndex: number, layout: HzLayout, theme: Theme, dpr: number, time: number)",
    ],
    ["    hide(time) {", "    hide(time: number) {"],
    [
      "rebuild(line, layout, theme, dpr)",
      "rebuild(line: Line, layout: HzLayout, theme: Theme, dpr: number)",
    ],
    ["restart(time)", "restart(time: number)"],
    ["update(time, staticMode)", "update(time: number, staticMode: boolean)"],
  ],
  rippleFilter: [
    [
      "(pixi, data, width, height) => new pixi.BufferImageSource({",
      "(pixi: PixiModule, data: Float32Array<ArrayBuffer>, width: number, height: number) => Object.assign(new pixi.BufferImageSource({",
    ],
    [
      "alphaMode: 'no-premultiply-alpha',\n});",
      "alphaMode: 'no-premultiply-alpha',\n}), { resource: data });",
    ],
    ["(pixi, width, height) =>", "(pixi: PixiModule, width: number, height: number) =>"],
    ["(pixi) =>", "(pixi: PixiModule) =>"],
    [
      "(pixi, { fieldSources, historySource, beatSource }) =>",
      "(pixi: PixiModule, { fieldSources, historySource, beatSource }: { fieldSources: ReturnType<typeof createFieldSource>[]; historySource: ReturnType<typeof createHistorySource>; beatSource: ReturnType<typeof createHistorySource> }) =>",
    ],
  ],
};
const imports = {
  beatDetector: "import type { HzAudio } from '../../../hz52/types';\n",
  lineLayout:
    "import { splitLyricGraphemes } from '@/components/Partita/model';\nimport type { HzFont, HzGlyph, HzLayout } from '../../../hz52/types';\ntype CharEntry = { char: string; index: number };\ntype MeasuredEntry = CharEntry & { width: number };\n",
  lyricText:
    "import type { Container } from 'pixi.js';\nimport type { Line, Theme } from '../../types';\nimport type { HzLayout, PixiModule } from '../../../hz52/types';\n",
  rippleFilter: "import type { PixiModule } from '../../../hz52/types';\n",
};
for (const [name, replacements] of Object.entries(changes)) {
  const original = `mods/visualizer52hz/${name}.mjs`;
  let source = execFileSync("git", ["-C", resolve(upstream), "show", `${revision}:${original}`], {
    encoding: "utf8",
  });
  for (const [match, replacement] of replacements) {
    if (!source.includes(match)) throw new Error(`52Hz 上游适配位置已变化：${name} ${match}`);
    source = source.replace(match, replacement);
  }
  source = source.replace(/from '(\.\/\w+)\.mjs'/g, "from '$1'");
  source = source.replace(
    /(const ctx = .*getContext\('2d'(?:, \{ willReadFrequently: true \})?\);)/g,
    '$1\nif (!ctx) throw new Error("52Hz 无法创建二维画布");',
  );
  const destination = resolve(
    root,
    "src/components/LyricPV/vendor/mods/visualizer52hz",
    `${name}.ts`,
  );
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(
    destination,
    await format(
      `// 由 scripts/vendor-lyric-52hz.mjs 从 Folia ${revision} 导入，AGPL-3.0。\n// 上游文件：${original}；修改导入脚本后重新生成。\n${imports[name] ?? ""}${source}`,
      { ...formatting, parser: "typescript" },
    ),
  );
}
console.log(`已导入 ${Object.keys(changes).length} 个 52Hz 算法文件，Folia ${revision}`);
