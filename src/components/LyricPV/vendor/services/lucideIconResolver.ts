import { Flower, Heart, Music, Sparkles, Star, type IconNode } from "lucide";

// 直接读取 Lucide 的 SVG 数据用于 Canvas，不引入 React 或图标组件运行时。
export type { IconNode } from "lucide";
const icons: Record<string, IconNode> = { Flower, Heart, Music, Sparkles, Star };
export const resolveLucideIconNode = (name: string | null | undefined): IconNode | null =>
  name ? (icons[name] ?? null) : null;
export const resolveLucideIconNames = (names: readonly string[] | undefined) =>
  [...new Set(names ?? [])].filter((name) => name in icons);
