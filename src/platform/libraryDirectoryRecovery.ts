import { computed, type Ref } from "vue";
import { filesSession, type FilesSession, type FileOperationResult } from "./filesSession";
import { localFilesSession } from "./localFilesSession";
import type { DirectorySelection } from "./mygo.bindings";

export interface LibraryDirectoryHints {
  read(): readonly string[];
  write(paths: string[]): void;
}

/** Display paths only: a saved hint never becomes a directory capability. */
export function createLibraryDirectoryRecovery(
  hints: LibraryDirectoryHints,
  current: Readonly<Ref<FilesSession | undefined>> = filesSession,
) {
  const pendingPaths = computed(() => {
    const authorized = new Set(
      current.value?.ready.value
        ? current.value.directories.value.map((grant) => grant.displayPath)
        : [],
    );
    return [...new Set(hints.read().filter((path) => path && !authorized.has(path)))];
  });

  async function choose(): Promise<FileOperationResult<DirectorySelection>> {
    const owner = current.value;
    if (!owner?.ready.value) return { status: "unavailable" };
    const library = localFilesSession.value;
    const tokens = new Set(owner.directories.value.map((grant) => grant.token));
    const result = await owner.chooseDirectory();
    if (
      current.value !== owner ||
      filesSession.value !== owner ||
      !owner.ready.value ||
      localFilesSession.value !== library
    ) {
      return { status: "stale" };
    }
    if (result.status !== "completed") return result;
    const selection = result.value;
    const grant = selection.grant;
    if (
      selection.status !== "selected" ||
      !grant ||
      tokens.has(grant.token) ||
      !owner.directories.value.some(
        (accepted) =>
          accepted.token === grant.token &&
          accepted.epoch === grant.epoch &&
          accepted.displayPath === grant.displayPath,
      )
    ) {
      return result;
    }
    if (grant.displayPath) {
      hints.write([...new Set([...hints.read().filter(Boolean), grant.displayPath])]);
    }
    // Existing scan semantics cancel an earlier scan but retain other grants and their rows.
    await library?.scan();
    return result;
  }

  return { pendingPaths, choose };
}
