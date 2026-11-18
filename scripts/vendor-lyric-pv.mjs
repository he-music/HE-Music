import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { removePVBackgroundHaze } from "./lyric-pv-transparent.mjs";
import { adaptPVSafeLayout } from "./lyric-pv-layout.mjs";

// 固定上游版本，只导入两套效果的纯 TypeScript 引擎；Vue 宿主和平台适配独立维护。
export const revision = "a8885a87539b92fb1149fc58ef0f033ad65ec042";
const upstream = process.argv[2];
if (!upstream) throw new Error("用法：node scripts/vendor-lyric-pv.mjs <folia-major 仓库路径>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const formatting = await resolveConfig(resolve(root, "package.json"));
const git = (...args) =>
  execFileSync("git", ["-C", resolve(upstream), ...args], { encoding: "utf8" });
const commit = git("rev-parse", `${revision}^{commit}`).trim();
const folders = ["hanabi", "lumiere", "pixi"].map((name) => `src/components/visualizer/${name}/`);
const shared = [
  "paragraphStructure",
  "visualizerSeedHash",
  "wordColoring",
  "pixiSceneCache",
  "pixiSongSwap",
  "lucidePath2d",
  "pixiFilterVertex",
].map((name) => `src/components/visualizer/${name}.ts`);
const utilities = [
  "colorMix",
  "textMeasureCache",
  "lyricRenderQuality",
  "lyrics/graphemeTiming",
  "lyrics/wordSegmentation",
  "lyrics/renderHints",
].map((name) => `src/utils/${name}.ts`);
const tracked = git(
  "ls-tree",
  "-r",
  "--name-only",
  commit,
  "--",
  ...folders,
  ...shared,
  ...utilities,
)
  .trim()
  .split("\n");
const selected = new Set(process.argv.slice(3));
const files = tracked.filter(
  (path) =>
    path.endsWith(".ts") &&
    !path.endsWith("/tuning.ts") &&
    !path.endsWith("/pixiRuntimeHost.ts") &&
    (selected.size === 0 || selected.has(path)),
);
for (const path of files) {
  let source = git("show", `${commit}:${path}`);
  const relative = path.slice("src/".length);
  // MotionValue 在这些引擎中只作读值契约；宿主用 Vue ref 适配，运行时无需 React 或 Motion。
  source = source.replace(
    /import type \{ MotionValue \} from 'framer-motion';/g,
    `import type { MotionValue } from '${"../".repeat(relative.split("/").length - 1)}types';`,
  );
  source = source.replace(
    "import type { IconNode } from 'lucide-react';",
    `import type { IconNode } from '${"../".repeat(relative.split("/").length - 1)}services/lucideIconResolver';`,
  );
  if (relative === "utils/lyrics/graphemeTiming.ts") {
    source = source.replace(
      /const graphemeSegmenter[\s\S]*?(?=const findGraphemeSequence)/,
      `export { splitLyricGraphemes } from "@/components/Partita/model";
const buildEvenGraphemeTimings = (text: string, startTime: number, endTime: number, wordIndex?: number): GraphemeTiming[] =>
  sharedGraphemeTimings(text, startTime, endTime).map(timing => ({ ...timing, ...(wordIndex === undefined ? {} : { wordIndex }) }));
export const buildWordGraphemeTimings = (word: Word, wordIndex?: number): GraphemeTiming[] =>
  word.syllables?.length
    ? word.syllables.flatMap(syllable => buildEvenGraphemeTimings(syllable.text, syllable.startTime, syllable.endTime, wordIndex))
    : buildEvenGraphemeTimings(word.text, word.startTime, word.endTime, wordIndex);
\n`,
    );
    source = `import { splitLyricGraphemes, buildWordGraphemeTimings as sharedGraphemeTimings } from "@/components/Partita/model";\n${source}`;
  }
  if (
    relative.endsWith("/createHanabiPixiRuntime.ts") ||
    relative.endsWith("/createLumierePixiRuntime.ts")
  ) {
    // 字形准备或着色器链接失败后也释放已经创建的 GPU 资源。
    source = source.replace(
      "await runtime.install();",
      "try { await runtime.install(); } catch (error) { runtime.destroy(); throw error; }",
    );
  }
  if (relative === "components/visualizer/hanabi/overlay.ts") {
    // 去掉左上角的「花火」圆形朱印，保留其他画框装饰。
    source = source.replace(/ {4}\/\/ 左上角的朱印。[\s\S]*?(?= {4}\/\/ 右缘竖排的 HANABI。)/, "");
    source = source.replace("g, sealText, ...letters", "g, ...letters");
    source = source.replace("左上角一枚「花火」朱印，", "");
  }
  source = removePVBackgroundHaze(relative, source);
  source = adaptPVSafeLayout(relative, source);
  source = source.replace(/\u3000/g, "\\u3000");
  const destination = resolve(root, "src/components/LyricPV/vendor", relative);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(
    destination,
    await format(
      `// 由 scripts/vendor-lyric-pv.mjs 从 Folia ${commit} 导入，AGPL-3.0。\n// 上游文件：${path}；修改源头或导入脚本后重新生成。\n${source}`,
      { ...formatting, parser: "typescript" },
    ),
  );
}
console.log(`已导入 ${files.length} 个纯 TypeScript 引擎文件，Folia ${commit}`);
