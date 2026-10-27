import type { ShortcutAction, ShortcutCheck, ShortcutEvent, ShortcutStatus } from "./mygo.bindings";

export type GlobalShortcutAction = ShortcutAction | "toggleDesktopLyric";
export const playbackShortcutActions: readonly ShortcutAction[] = [
  "playOrPause",
  "playPrev",
  "playNext",
  "volumeUp",
  "volumeDown",
];
export interface GlobalShortcutBinding {
  action: GlobalShortcutAction;
  accelerator: string;
}
export interface GlobalShortcutResult {
  action: GlobalShortcutAction;
  accelerator: string;
  normalized: string;
  status: string;
  error: string;
}
export interface GlobalShortcutStatus extends Omit<ShortcutStatus, "results"> {
  results: GlobalShortcutResult[];
}
export interface PlatformShortcuts {
  readonly actions: readonly GlobalShortcutAction[];
  replace(
    generation: number,
    enabled: boolean,
    bindings: GlobalShortcutBinding[],
  ): Promise<GlobalShortcutStatus>;
  suspend(generation: number): Promise<GlobalShortcutStatus>;
  teardown(generation: number): Promise<void>;
  check(generation: number, accelerator: string): Promise<ShortcutCheck>;
  onAction(listener: (event: ShortcutEvent) => void): () => void;
}
