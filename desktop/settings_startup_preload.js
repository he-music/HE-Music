// Only the Go-verified private window navigates to this exact owned origin.
// Opaque blank and foreign documents must not touch storage or install listeners.
if (location.protocol !== "about:" && location.origin === __SETTINGS_STARTUP_ORIGIN__) {
  localStorage.setItem("shortcut-store", JSON.stringify({ globalOpen: false }));
  localStorage.setItem(
    "setting-store",
    JSON.stringify({ smtcOpen: false, preventSleep: false, autoPlay: false }),
  );
  const runtime = {
    documentId: crypto.randomUUID(),
    errors: 0,
    rejections: 0,
    unknownErrors: 0,
  };
  window.__settingsStartupRuntime = runtime;
  addEventListener(
    "error",
    () => {
      runtime.errors++;
      runtime.unknownErrors++;
    },
    true,
  );
  addEventListener(
    "unhandledrejection",
    () => {
      runtime.rejections++;
      runtime.unknownErrors++;
    },
    true,
  );
}
