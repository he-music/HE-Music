import type { GlobalThemeOverrides } from "naive-ui";
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
] as const satisfies readonly ImmersiveSkinPreset[];
export type ImmersiveSkin = "none" | (typeof immersiveSkins)[number]["id"];

export function getImmersiveSkin(id: ImmersiveSkin): ImmersiveSkinPreset | undefined {
  return immersiveSkins.find((skin) => skin.id === id);
}
