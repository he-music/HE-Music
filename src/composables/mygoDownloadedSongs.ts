import { computed, type Ref } from "vue";
import type { FilesSession } from "@/platform/filesSession";
import { createLibrarySongRows } from "@/platform/librarySongRows";

export type MygoDownloadedSongsOwner = Pick<
  FilesSession,
  "ready" | "directories" | "libraryEntries"
>;

/** The download directory supplies songs; history never supplies file capabilities. */
export function useMygoDownloadedSongs(
  owner: Readonly<Ref<MygoDownloadedSongsOwner | undefined>>,
  directory: Readonly<Ref<string>>,
) {
  const entries = computed(() => {
    const current = owner.value;
    if (!current?.ready.value || !directory.value) return [];
    const tokens = new Set(
      current.directories.value
        .filter((grant) => grant.displayPath === directory.value)
        .map((grant) => grant.token),
    );
    return current.libraryEntries.filter(
      (entry) => tokens.has(entry.ref.grantToken) && entry.relativePath === entry.ref.relativePath,
    );
  });
  return { songs: createLibrarySongRows(entries) };
}
