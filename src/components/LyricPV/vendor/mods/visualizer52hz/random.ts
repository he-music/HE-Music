// 由 scripts/vendor-lyric-52hz.mjs 从 Folia a8885a87539b92fb1149fc58ef0f033ad65ec042 导入，AGPL-3.0。
// 上游文件：mods/visualizer52hz/random.mjs；修改导入脚本后重新生成。
// mods/visualizer52hz/random.mjs
// Seeded randomness, so a line's scatter and a pith's shape come out the same
// every time they are drawn (resize, theme change, seeking back).

/** 32-bit FNV-1a hash of a string. */
export const hashString = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** mulberry32: returns a function yielding floats in [0, 1). */
export const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const between = (random: () => number, min: number, max: number) =>
  min + (max - min) * random();
