import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

// 保留 Folia DOM 效果的原算法，只替换框架类型与项目接入路径。
const revision = "a8885a87539b92fb1149fc58ef0f033ad65ec042";
const upstream = process.argv[2];
if (!upstream) throw new Error("用法：node scripts/vendor-lyric-dom.mjs <folia-major 仓库路径>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const formatting = await resolveConfig(resolve(root, "package.json"));
const sourceAt = (path) =>
  execFileSync("git", ["-C", resolve(upstream), "show", `${revision}:${path}`], {
    encoding: "utf8",
  });
const visualizers = [
  "partita/partitaLayout",
  "partita/partitaOverlap",
  "glowWordTiming",
  "glowWordOverlap",
  "glowWordVariants",
  "monet/monetLyricMotion",
  "monet/monetLyricsModel",
  "monet/monetRailLayout",
  "wordGlow",
];
const utilities = [
  "cjkSemanticLayout",
  "alternateText",
  "estimatedLineTiming",
  "subtitleTrackStyle",
  "textDirection",
];
const files = [
  ...visualizers.map((name) => `src/components/visualizer/${name}.ts`),
  ...utilities.map((name) => `src/utils/lyrics/${name}.ts`),
];
async function save(path, source, original = path) {
  const destination = resolve(root, "src/components/LyricDom/vendor", path.slice(4));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(
    destination,
    await format(
      `// 由 scripts/vendor-lyric-dom.mjs 从 Folia ${revision} 导入，AGPL-3.0。\n// 上游文件：${original}；修改导入脚本后重新生成。\n${source}`,
      { ...formatting, parser: "typescript" },
    ),
  );
}
for (const path of files) {
  let source = sourceAt(path);
  source = source.replace(
    "import React from 'react';",
    "import type { CSSProperties } from 'vue';",
  );
  source = source.replace(
    "import type React from 'react';",
    "import type { CSSProperties } from 'vue';",
  );
  source = source.replaceAll("React.CSSProperties", "CSSProperties");
  source = source.replace(
    "import type { Variants } from 'framer-motion';",
    "import type { Variants, WordMotionCustom } from '../../types';",
  );
  source = source.replaceAll(": any", ": WordMotionCustom");
  if (path.endsWith("/wordGlow.ts")) {
    source = source.replace("Variants, WordMotionCustom", "GlowVariants as Variants");
    source = source.replace(
      "import { isGlowBlurQuantized } from '../../utils/glowBlurQuantize';",
      "// 固定半径、仅改变 opacity，避免逐帧文字栅格化。\nconst isGlowBlurQuantized = () => false;",
    );
  }
  source = source.replace(
    "import { type VisualizerPreheatWindow } from '../runtime';",
    "import type { VisualizerPreheatWindow } from '../../../types';",
  );
  // 复用最近移植已经固定在同一提交的工具，避免维护两份分词与测量缓存。
  for (const utility of [
    "colorMix",
    "textMeasureCache",
    "lyrics/graphemeTiming",
    "lyrics/wordSegmentation",
    "lyrics/renderHints",
  ]) {
    source = source.replaceAll(
      new RegExp(`from '[^']*utils/${utility.replaceAll("/", "\\/")}'`, "g"),
      `from '@/components/LyricPV/vendor/utils/${utility}'`,
    );
  }
  if (path.startsWith("src/utils/lyrics/")) {
    for (const utility of ["graphemeTiming", "wordSegmentation"]) {
      source = source.replaceAll(
        `from './${utility}'`,
        `from '@/components/LyricPV/vendor/utils/lyrics/${utility}'`,
      );
    }
  }
  if (path.endsWith("/glowWordVariants.ts"))
    source = source.replace("passed: ({ config, baseColor }", "passed: ({ config }");
  if (path.endsWith("/monetLyricsModel.ts"))
    source = source.replace(
      "text: string, fontSpec: string, fontPx: number, defaultLineHeightPx",
      "text: string, fontSpec: string, _fontPx: number, defaultLineHeightPx",
    );
  if (path.endsWith("/partitaLayout.ts"))
    source = source
      .replace("const isCJK =", "export const isCJK =")
      .replace("const getTargetColumnCount =", "export const getTargetColumnCount =");
  if (path.endsWith("/partitaLayout.ts"))
    source = source.replace("let currentWords:", "const currentWords:");
  if (path.endsWith("/partitaOverlap.ts"))
    source = source.replace("        const direction = row.rtl ? 'rtl' : 'ltr';", "");
  source = source.replaceAll(
    "from '../wordColoring'",
    "from '@/components/LyricPV/vendor/components/visualizer/wordColoring'",
  );
  await save(path, source);
}
// 流光的排版仍在 React 组件中：抽出原 useMemo 的纯计算体，使用实际歌词区域宽度。
const classic = sourceAt("src/components/visualizer/classic/Visualizer.tsx");
const start = classic.indexOf("        const seed = activeLine.startTime;");
const finish = classic.indexOf("        return { wordConfigs, lineConfig };", start);
if (start < 0 || finish < 0) throw new Error("流光上游排版提取位置已变化");
const body = classic
  .slice(start, finish + "        return { wordConfigs, lineConfig };".length)
  .replace(
    "/* eslint-disable-next-line no-warning-comments -- @AI: KEEP THIS EXACTLY AS IS */",
    "",
  );
await save(
  "src/components/visualizer/classic/classicLayout.ts",
  `
import type { Line, Theme, ClassicTuning, WordLayoutConfig, LineLayoutConfig } from '../../../types';
import { getGlowWordOverflow, getGlowWordPairGap, measureGlowWordWidth as measureWordWidth, type GlowWordPlacement } from '../glowWordOverlap';
import { resolveLyricTextDirection } from '../../../utils/lyrics/textDirection';
const resolveThemeFontStack = (theme: Theme) => theme.fontFamily ?? 'sans-serif';
const resolveThemeFontWeight = (theme: Theme, fallback: number) => theme.fontWeight ?? fallback;
export function buildClassicLayout(activeLine: Line, displayWords: Line['words'], theme: Theme, resolvedClassicTuning: ClassicTuning, viewportWidth: number, lineFontScale: number) {
${body}
}
`,
  "src/components/visualizer/classic/Visualizer.tsx（排版 useMemo）",
);
console.log(`已导入 ${files.length + 1} 个 DOM 算法文件，Folia ${revision}`);
