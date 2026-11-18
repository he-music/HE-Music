import type { Theme } from "../types";

// 字体由现有 lyricFontStyle 解析后传入，不读取 Folia 的设置仓库。
export const resolveThemeFontStack = (theme: Theme) =>
  theme.fontFamily || 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
export const resolveThemeFontWeight = (theme: Theme, fallback = 700) =>
  theme.fontWeight ?? fallback;
