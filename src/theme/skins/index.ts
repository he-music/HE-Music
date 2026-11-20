import type { GlobalThemeOverrides } from "naive-ui";
import { apricotBloom } from "./apricotBloom";
import { iceLake } from "./iceLake";
import { pineAfterRain } from "./pineAfterRain";

interface ImmersiveSkinPreset {
  id: string;
  labelKey: string;
  mode: "light" | "dark";
  cssVariables: Readonly<Record<`--skin-${string}`, string>>;
  themeOverrides: GlobalThemeOverrides;
}

export const immersiveSkins = [
  iceLake,
  pineAfterRain,
  apricotBloom,
] as const satisfies readonly ImmersiveSkinPreset[];
export type ImmersiveSkin = "none" | (typeof immersiveSkins)[number]["id"];

export function getImmersiveSkin(id: ImmersiveSkin): ImmersiveSkinPreset | undefined {
  return immersiveSkins.find((skin) => skin.id === id);
}
