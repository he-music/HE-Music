import { watch } from "vue";
import { platform } from "@/platform";
import { updatesState } from "@/platform/updates";

let activeOwner: object | undefined;

/** The plugin owns checks and installations for the application's lifetime. */
export function createShellUpdatesSession(automaticCheck: () => boolean) {
  const provider = platform.updates;
  if (!platform.lifecycle || !provider) return;
  const owner = {};
  let disposed = false;
  let starting: Promise<void> | undefined;
  let off: (() => void) | undefined;
  let stop: (() => void) | undefined;
  let configuring = Promise.resolve();

  const configure = (enabled: boolean) => {
    configuring = configuring
      .catch(() => {})
      .then(async () => {
        if (!disposed && activeOwner === owner) await provider.configure(enabled);
      });
    return configuring;
  };

  return {
    start() {
      return (starting ??= (async () => {
        if (disposed) return;
        activeOwner = owner;
        updatesState.value = undefined;
        const receive = (state: Awaited<ReturnType<typeof provider.getState>>) => {
          if (disposed || activeOwner !== owner) return;
          if (!updatesState.value || state.revision >= updatesState.value.revision) {
            updatesState.value = state;
          }
        };
        off = provider.onChange(receive);
        try {
          receive(await provider.getState());
          if (disposed) return;
          stop = watch(automaticCheck, (enabled) => {
            void configure(enabled).catch((error: unknown) =>
              console.error("同步更新设置失败", error),
            );
          });
          await configure(automaticCheck());
        } catch (error) {
          off?.();
          if (activeOwner === owner) updatesState.value = undefined;
          throw error;
        }
      })());
    },
    async dispose() {
      disposed = true;
      off?.();
      stop?.();
      if (activeOwner === owner) {
        activeOwner = undefined;
        updatesState.value = undefined;
      }
      await configuring.catch(() => {});
    },
  };
}
