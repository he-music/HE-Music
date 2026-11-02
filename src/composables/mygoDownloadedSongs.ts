import { computed, type Ref } from "vue";
import type { FilesSession } from "@/platform/filesSession";
import type { LocalDownloadTask } from "@/platform/localDownloadSession";
import { createLibrarySongRows } from "@/platform/librarySongRows";

export type MygoDownloadedSongsOwner = Pick<
  FilesSession,
  "ready" | "directories" | "libraryEntries"
>;

/** Resolve optional file actions for records; scanning never creates or removes a task. */
export function useMygoDownloadedSongs(
  owner: Readonly<Ref<MygoDownloadedSongsOwner | undefined>>,
  tasks: Readonly<Ref<readonly LocalDownloadTask[]>>,
) {
  const matches = computed(() => {
    const current = owner.value;
    if (!current?.ready.value) return [];
    const entries = current.libraryEntries;
    return tasks.value.flatMap((task) => {
      if (!task.done || !task.committed || !task.target) return [];
      const target = task.target;
      const tokens = new Set(
        current.directories.value
          .filter((grant) => grant.displayPath === target.directory)
          .map((grant) => grant.token),
      );
      const entry = entries.find(
        (entry) =>
          tokens.has(entry.ref.grantToken) &&
          entry.relativePath === target.relativePath &&
          entry.ref.relativePath === target.relativePath,
      );
      return entry ? [{ id: task.id, entry }] : [];
    });
  });
  const songs = createLibrarySongRows(computed(() => matches.value.map((match) => match.entry)));
  const files = computed(
    () => new Map(matches.value.map((match, index) => [match.id, songs.value[index]])),
  );
  return { songs, files };
}
