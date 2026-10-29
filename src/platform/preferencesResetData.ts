import localforage from "localforage";

// music-data/music and user-data/user are cleared by dataStore.deleteDB().
// These remaining application stores contain cached rows/blobs/history only.
const additionalResetStores = [
  { name: "local-data", storeName: "local_download_history" },
  { name: "local-data", storeName: "local" },
  { name: "background-data", storeName: "background" },
] as const;

/** Call only after disposing FilesSession, which drains queued history saves. */
export async function clearAdditionalPreferencesData(
  current: () => boolean = () => true,
): Promise<void> {
  for (const store of additionalResetStores) {
    if (!current()) throw new Error("Preferences reset owner replaced");
    await localforage.dropInstance({ ...store });
  }
}
