const writeBlocks = new Set<symbol>();
let stopLocalAudio: (() => void) | undefined;

/** The player owns stopping its source and invalidating a pending local load. */
export function registerLocalAudioStopper(stop: () => void): void {
  stopLocalAudio = stop;
}

export function blockLocalAudio(): () => void {
  const token = Symbol("local-file-write");
  writeBlocks.add(token);
  try {
    stopLocalAudio?.();
  } catch (error) {
    writeBlocks.delete(token);
    throw error;
  }
  return () => {
    writeBlocks.delete(token);
  };
}

export function localAudioBlocked(): boolean {
  return writeBlocks.size > 0;
}
