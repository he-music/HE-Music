const startupRecords: Array<Record<string, unknown>> = [];

export function settingsStartupDiagnostics() {
  return startupRecords;
}

/** Startup only: Naive destroyAll hides current instances; DOM removal waits for leave. */
export async function prepareKnownSettingsStartup() {
  if (!import.meta.env.DEV || document.querySelector(".main-setting"))
    throw new Error("settings-file-probe-startup-only");
  const deadline = performance.now() + 5000;
  const snapshot = () => {
    const modals = [...document.querySelectorAll(".n-modal-container")];
    return {
      modals: modals.length,
      agreements: modals.filter((node) => node.querySelector(".user-agreement")).length,
      logins: modals.filter((node) => node.querySelector(".login")).length,
      unknown:
        modals.filter((node) => !node.querySelector(".user-agreement,.login")).length +
        document.querySelectorAll("vite-error-overlay").length,
      drawers: document.querySelectorAll(".n-drawer").length,
      settings: document.querySelectorAll(".main-setting").length,
    };
  };
  for (let round = 0; round < 3; round++) {
    const before = snapshot();
    if (before.unknown || before.drawers || before.settings) {
      startupRecords.push({ round, before, action: "fail-unknown-surface" });
      throw new Error("settings-file-probe-unknown-startup-overlay");
    }
    if (!before.modals) {
      startupRecords.push({ round, before, action: "no-modal", passed: true });
      return;
    }
    // The complete set was verified above; no settings or unknown modal may be hidden.
    window.$modal.destroyAll();
    const roundDeadline = Math.min(deadline, performance.now() + 1500);
    while (snapshot().modals && performance.now() < roundDeadline) {
      const current = snapshot();
      if (current.unknown || current.drawers || current.settings) {
        startupRecords.push({ round, before, after: current, action: "fail-new-unknown" });
        throw new Error("settings-file-probe-new-unknown-startup-overlay");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const after = snapshot();
    startupRecords.push({
      round,
      before,
      after,
      action: "hide-known-initial-agreement-login",
      roundDeadlineReached: performance.now() >= roundDeadline,
      deadlineReached: performance.now() >= deadline,
    });
    if (performance.now() >= deadline) break;
  }
  const final = snapshot();
  if (final.modals || final.drawers || final.settings || final.unknown)
    throw new Error("settings-file-probe-startup-leave-timeout");
}
