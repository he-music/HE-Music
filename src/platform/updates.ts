import { shallowRef } from "vue";
import type { UpdatesState } from "./mygo.bindings";

export interface PlatformUpdates {
  getState(): Promise<UpdatesState>;
  configure(automaticChecks: boolean): Promise<void>;
  check(): Promise<void>;
  onChange(listener: (state: UpdatesState) => void): () => void;
}

export const updatesState = shallowRef<UpdatesState>();
export type { UpdatesState };
