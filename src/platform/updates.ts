import type { UpdatesEvent, UpdatesState } from "./mygo.bindings";

export interface PlatformUpdates {
  begin(requestID: number): Promise<void>;
  getState(requestID: number, epoch: number): Promise<void>;
  check(requestID: number, epoch: number, revision: number): Promise<void>;
  download(requestID: number, epoch: number, revision: number): Promise<void>;
  install(requestID: number, epoch: number, revision: number): Promise<void>;
  teardown(requestID: number, epoch: number): Promise<void>;
  onChange(listener: (event: UpdatesEvent) => void): () => void;
}

export type { UpdatesEvent, UpdatesState };
