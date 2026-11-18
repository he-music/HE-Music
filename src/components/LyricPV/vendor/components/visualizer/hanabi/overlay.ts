// 由 scripts/vendor-lyric-pv.mjs 从 Folia a8885a87539b92fb1149fc58ef0f033ad65ec042 导入，AGPL-3.0。
// 上游文件：src/components/visualizer/hanabi/overlay.ts；修改源头或导入脚本后重新生成。
// Copyright (c) 2026 chthollyphile
import type { Container, TextStyleFontWeight } from "pixi.js";
import type { Theme } from "../../../types";
import { resolveThemeFontStack, resolveThemeFontWeight } from "../../../utils/fontStacks";
import { resolveHanabiPalette } from "./color";
import type { HanabiTuning, PixiModule } from "./types";

// src/components/visualizer/hanabi/overlay.ts
// 花火的画框装饰：右缘竖排的小字 HANABI，左下三颗烟花色的圆点 + 细线，右下一个角标。
// 静态、小而淡，离画面边缘留足（内核的镜头畸变会把边缘 5% 推出画面）。

export const buildHanabiOverlay = (
  pixi: PixiModule,
  width: number,
  height: number,
  theme: Theme,
  colorMode: HanabiTuning["colorMode"],
  resolution = 1,
): Container => {
  const container = new pixi.Container();
  const palette = resolveHanabiPalette("kawaii", theme, colorMode);
  const unit = Math.min(width, height);
  const padX = Math.max(width * 0.07, unit * 0.06);
  const padY = Math.max(height * 0.08, unit * 0.06);
  const line = Math.max(1.2, unit / 640);
  const font = resolveThemeFontStack(theme);
  const weight = String(resolveThemeFontWeight(theme, 700)) as TextStyleFontWeight;
  const g = new pixi.Graphics();

  // 右缘竖排的 HANABI。
  const letterSize = unit * 0.017;
  const letters = Array.from("HANABI").map((char, i) => {
    const label = new pixi.Text({
      text: char,
      style: new pixi.TextStyle({
        fontFamily: font,
        fontWeight: weight,
        fontSize: letterSize,
        fill: palette.paper,
      }),
      resolution,
    });
    label.anchor.set(0.5);
    label.alpha = 0.55;
    label.position.set(width - padX, padY + letterSize * (0.6 + i * 1.5));
    return label;
  });
  const stemTop = padY + letterSize * (0.6 + 6 * 1.5);
  g.moveTo(width - padX, stemTop)
    .lineTo(width - padX, stemTop + unit * 0.08)
    .stroke({ color: palette.paper, width: line, alpha: 0.35 });

  // 左下三颗圆点 + 细线。
  const dotY = height - padY;
  palette.sparks.slice(0, 3).forEach((color, i) => {
    g.circle(padX + i * unit * 0.018, dotY, unit * 0.0055).fill({ color, alpha: 0.85 });
  });
  g.moveTo(padX + unit * 0.05, dotY)
    .lineTo(padX + unit * 0.16, dotY)
    .stroke({ color: palette.paper, width: line, alpha: 0.35 });

  // 右下角标。
  const arm = unit * 0.035;
  g.moveTo(width - padX - arm, height - padY)
    .lineTo(width - padX, height - padY)
    .lineTo(width - padX, height - padY - arm)
    .stroke({ color: palette.accent, width: line * 1.4, alpha: 0.6 });

  container.addChild(g, ...letters);
  return container;
};
