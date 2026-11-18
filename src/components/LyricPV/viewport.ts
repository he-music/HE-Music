import type { Theme } from "./vendor/types";

// 画布保持完整视口；只把各镜头的歌词区映射到歌曲信息与控制栏之间。
export interface PVSafeArea {
  top: number;
  bottom: number;
}
interface PVProfile {
  region: { cx: number; cy: number; w: number; h: number };
  heroSize?: number;
  text?: { heroSize: number };
}

export function fitPVProfile<T extends PVProfile>(
  profile: T,
  theme: Pick<Theme, "lyricSafeArea">,
): T {
  const area = theme.lyricSafeArea;
  if (!area) return profile;
  const height = Math.max(0.25, 1 - area.top - area.bottom);
  return {
    ...profile,
    region: {
      ...profile.region,
      cy: area.top + profile.region.cy * height,
      h: profile.region.h * height,
    },
    ...(profile.heroSize === undefined ? {} : { heroSize: profile.heroSize * height }),
    ...(profile.text
      ? { text: { ...profile.text, heroSize: profile.text.heroSize * height } }
      : {}),
  };
}

export function resolvePVSafeArea(
  height: number,
  top: number,
  bottom: number,
): PVSafeArea | undefined {
  if (height <= 0) return;
  const safeTop = Math.max(0, Math.min(top / height, 0.5));
  const safeBottom = Math.max(0, Math.min(bottom / height, 0.25));
  return { top: safeTop, bottom: safeBottom };
}
