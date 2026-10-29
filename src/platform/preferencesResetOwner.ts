export interface PreferencesResetFilesOwner {
  current(): boolean;
  dispose(): Promise<void>;
}

/** Capture a one-shot FilesSession's epoch and registry generation. The registry
 * generation also detects an intervening replacement that was itself disposed. */
export function capturePreferencesResetFilesOwner(source: {
  ownsEpoch(): boolean;
  registryGeneration(): number;
  registryEmpty(): boolean;
  dispose(): Promise<void>;
}): PreferencesResetFilesOwner {
  const generation = source.registryGeneration();
  let releasedGeneration: number | undefined;
  const current = () =>
    releasedGeneration === undefined
      ? source.registryGeneration() === generation && source.ownsEpoch()
      : source.registryGeneration() === releasedGeneration && source.registryEmpty();
  return {
    current,
    async dispose() {
      if (!current()) throw new Error("Files reset owner replaced");
      const cleanup = source.dispose();
      releasedGeneration = source.registryGeneration();
      await cleanup;
      if (!current()) throw new Error("Files reset owner replaced during disposal");
    },
  };
}
