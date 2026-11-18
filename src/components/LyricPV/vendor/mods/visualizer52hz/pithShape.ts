// 由 scripts/vendor-lyric-52hz.mjs 从 Folia a8885a87539b92fb1149fc58ef0f033ad65ec042 导入，AGPL-3.0。
// 上游文件：mods/visualizer52hz/pithShape.mjs；修改导入脚本后重新生成。
// mods/visualizer52hz/pithShape.mjs
// A song without lyrics still grows rings: each few seconds a new "pith" — a
// small closed blob, off-center and irregular like the heart of a real trunk —
// becomes the source the rings spread from. The outline is a circle bent by a
// few random low harmonics and stretched a little, so no two piths match.

import { computeDistanceField } from "./distanceField";
import { between, createRandom } from "./random";

const POINTS = 120;

/** The pith outline for `seed`: CSS px points of a closed curve. */
export const pithOutline = (seed: number, width: number, height: number) => {
  const random = createRandom(seed);
  const minSide = Math.min(width, height);
  const cx = width / 2 + between(random, -0.14, 0.14) * width;
  const cy = height / 2 + between(random, -0.14, 0.14) * height;
  const radius = minSide * between(random, 0.035, 0.07);
  const stretch = between(random, 0.75, 1.35);
  const tilt = between(random, 0, Math.PI);
  const harmonics = [2, 3, 4, 5, 7].map((k) => ({
    k,
    amplitude: between(random, 0, 0.32) / Math.sqrt(k),
    phase: between(random, 0, Math.PI * 2),
  }));

  const points: [number, number][] = [];
  for (let i = 0; i < POINTS; i += 1) {
    const theta = (i / POINTS) * Math.PI * 2;
    let r = 1;
    harmonics.forEach(({ k, amplitude, phase }) => {
      r += amplitude * Math.sin(k * theta + phase);
    });
    r = Math.max(0.35, r) * radius;
    const x = Math.cos(theta) * r * stretch;
    const y = Math.sin(theta) * r;
    points.push([
      cx + x * Math.cos(tilt) - y * Math.sin(tilt),
      cy + x * Math.sin(tilt) + y * Math.cos(tilt),
    ]);
  }
  return points;
};

/** The distance field of the pith for `seed`, on the same grid as the lyric fields. */
export const buildPithField = (
  seed: number,
  width: number,
  height: number,
  cell: number,
  gridWidth: number,
  gridHeight: number,
) => {
  const canvas = document.createElement("canvas");
  canvas.width = gridWidth;
  canvas.height = gridHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("52Hz 无法创建二维画布");
  ctx.scale(1 / cell, 1 / cell);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  pithOutline(seed, width, height).forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  const { data } = ctx.getImageData(0, 0, gridWidth, gridHeight);
  const alpha = new Uint8Array(gridWidth * gridHeight);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3];
  return computeDistanceField(alpha, gridWidth, gridHeight);
};
