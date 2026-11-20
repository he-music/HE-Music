import type { ComputedRef, InjectionKey } from "vue";

export type AppearanceThemeSource = "system" | "light" | "dark";

export const appearanceThemeSourceKey: InjectionKey<ComputedRef<AppearanceThemeSource>> =
  Symbol("appearanceThemeSource");
