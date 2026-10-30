import { computed, type Ref } from "vue";
import type { FilesSession } from "@/platform/filesSession";
import type { LocalDownloadTask } from "@/platform/localDownloadSession";
import { createLibrarySongRows } from "@/platform/librarySongRows";

export type MygoDownloadedSongsOwner = Pick<
  FilesSession,
  "ready" | "directories" | "libraryEntries"
>;

/** History identifies targets only; current scan entries supply every playable song. */
export function useMygoDownloadedSongs(
  owner: Readonly<Ref<MygoDownloadedSongsOwner | undefined>>,
  tasks: Readonly<Ref<readonly LocalDownloadTask[]>>,
) {
  // Progress updates must not recreate the completed SongList's data prop.
  type Targets = ReadonlyMap<string, ReadonlySet<string>>;
  const targets = computed<Targets>((previous) => {
    const next = new Map<string, Set<string>>();
    for (const task of tasks.value) {
      if (!task.committed || !task.target) continue;
      const { directory, relativePath } = task.target;
      const paths = next.get(directory) ?? new Set<string>();
      paths.add(relativePath);
      next.set(directory, paths);
    }
    if (
      previous?.size === next.size &&
      [...next].every(([directory, paths]) => {
        const before = previous.get(directory);
        return before?.size === paths.size && [...paths].every((path) => before.has(path));
      })
    )
      return previous;
    return next;
  });
  const entries = computed(() => {
    const current = owner.value;
    if (!current?.ready.value) return [];
    const grants = new Map(current.directories.value.map((grant) => [grant.token, grant]));
    const committed = targets.value;
    return current.libraryEntries.filter((entry) => {
      const grant = grants.get(entry.ref.grantToken);
      return (
        grant &&
        committed.get(grant.displayPath)?.has(entry.relativePath) &&
        entry.ref.relativePath === entry.relativePath
      );
    });
  });
  const songs = createLibrarySongRows(entries);
  const unmatched = computed(() => {
    const current = owner.value;
    const committed = tasks.value.filter((task) => task.committed);
    if (!current?.ready.value) return committed;
    const grants = new Map(current.directories.value.map((grant) => [grant.token, grant]));
    return committed.filter(
      (task) =>
        !entries.value.some(
          (entry) =>
            grants.get(entry.ref.grantToken)?.displayPath === task.target?.directory &&
            entry.relativePath === task.target?.relativePath,
        ),
    );
  });
  return { songs, unmatched };
}
