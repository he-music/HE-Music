import type { SystemMediaCommand, SystemMediaStatus, SystemMediaTrack } from "./mygo.bindings";

/** Optional native provider; configure owns media and an independent display lease. */
export interface PlatformSystemMedia {
  configure(
    generation: number,
    mediaEnabled: boolean,
    preventSleep: boolean,
  ): Promise<SystemMediaStatus>;
  set(generation: number, revision: number, track: SystemMediaTrack): Promise<void>;
  setPlayback(
    generation: number,
    revision: number,
    trackID: string,
    state: string,
    positionMS: number,
  ): Promise<void>;
  setArtwork?(generation: number, revision: number, trackID: string, base64: string): Promise<void>;
  clear(generation: number, revision: number): Promise<void>;
  teardown(generation: number): Promise<void>;
  onCommand(listener: (command: SystemMediaCommand) => void): () => void;
}
