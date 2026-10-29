import { computed, onScopeDispose, shallowRef, watch, type Ref } from "vue";
import { filesSession, type FilesSession, type FileOperationResult } from "./filesSession";

/** Modal state observes the shell's file owner; closing it never revokes that owner. */
export function createLocalDirectorySession(
  current: Readonly<Ref<FilesSession | undefined>> = filesSession,
  chooseDirectory: (session: FilesSession) => ReturnType<FilesSession["chooseDirectory"]> = (
    session,
  ) => session.chooseDirectory(),
) {
  const feedback = shallowRef("");
  const suggestion = shallowRef("");
  let active = true;
  let revision = 0;
  const stop = watch(current, () => {
    revision++;
    feedback.value = "";
    suggestion.value = "";
  });
  onScopeDispose(() => {
    active = false;
    revision++;
    stop();
  });

  async function perform<T>(
    operation: (session: FilesSession) => Promise<FileOperationResult<T>>,
    complete: (value: T) => void,
  ) {
    const session = current.value;
    if (!session) {
      feedback.value = "unavailable";
      return;
    }
    const request = ++revision;
    const result = await operation(session);
    if (!active || current.value !== session || revision !== request) return;
    if (result.status === "completed") complete(result.value);
    else feedback.value = result.status;
  }

  return {
    feedback,
    suggestion,
    ready: computed(() => current.value?.ready.value ?? false),
    busy: computed(() => current.value?.busy.value ?? false),
    grants: computed(() => current.value?.directories.value ?? []),
    choose: () =>
      perform(chooseDirectory, (value) => {
        feedback.value = value.status === "overlap" ? value.relation : value.status;
      }),
    showDefault: () =>
      perform(
        (session) => session.defaultDirectory("music"),
        (value) => {
          suggestion.value = value.displayPath;
          feedback.value = "suggestion";
        },
      ),
    revoke: (token: string) =>
      perform(
        (session) => session.revokeDirectory(token),
        () => {
          feedback.value = "revoked";
        },
      ),
  };
}
