import type { PlatformShortcuts, GlobalShortcutBinding, GlobalShortcutStatus } from "./shortcuts";
import { playbackShortcutActions } from "./shortcuts";

/** Preserve Electron's existing action IPC listeners; only registration moves here. */
export function createElectronShortcuts(): PlatformShortcuts {
  const ipc = window.electron.ipcRenderer;
  let generation = 0;
  let bindings: GlobalShortcutBinding[] = [];
  let enabled = false;
  const status = (suspended: boolean, failures: readonly string[]): GlobalShortcutStatus => ({
    generation: ++generation,
    enabled,
    suspended,
    results: bindings.map(({ action, accelerator }) => ({
      action,
      accelerator,
      normalized: accelerator,
      status: !accelerator
        ? "empty"
        : suspended || !enabled
          ? "disabled"
          : failures.includes(accelerator)
            ? "registration-failed"
            : "registered",
      error: "",
    })),
  });
  return {
    actions: [...playbackShortcutActions, "toggleDesktopLyric"],
    async replace(_generation, nextEnabled, nextBindings) {
      bindings = nextBindings;
      enabled = nextEnabled;
      if (!enabled) {
        ipc.send("unregister-all-shortcut");
        return status(false, []);
      }
      const shortcuts = Object.fromEntries(
        bindings.map(({ action, accelerator }) => [action, { globalShortcut: accelerator }]),
      );
      const response: unknown = await ipc.invoke("register-all-shortcut", shortcuts);
      const failures = Array.isArray(response)
        ? response.filter((value): value is string => typeof value === "string")
        : bindings.map((binding) => binding.accelerator);
      return status(false, failures);
    },
    async suspend() {
      ipc.send("unregister-all-shortcut");
      return status(true, []);
    },
    async teardown() {
      ipc.send("unregister-all-shortcut");
    },
    async check(_generation, accelerator) {
      const registered: unknown = await ipc.invoke("is-shortcut-registered", accelerator);
      return { normalized: accelerator, registeredByOwner: registered === true, error: "" };
    },
    onAction: () => () => {},
  };
}
