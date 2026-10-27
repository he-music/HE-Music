import { nextTick } from "vue";
import { openSetting } from "@/utils/modal";
import { platform } from "@/platform";
import { filesSession } from "@/platform/filesSession";
import { t } from "@/i18n";
import { prepareKnownSettingsStartup, settingsStartupDiagnostics } from "./settingsSurface";
import {
  installIsolation,
  prepareSurface,
  isolationDiagnostics,
  releaseIsolation,
} from "./isolation";

/** Only dynamically imported by the tagged, opt-in Go settings-file harness. */
export async function prepareSettingsFileProbe() {
  if (!import.meta.env.DEV || platform.kind !== "mygo" || !filesSession.value?.ready.value)
    throw new Error("settings-file-probe-development-session-required");
  const wait = async (predicate: () => boolean) => {
    const end = performance.now() + 5000;
    while (!predicate()) {
      if (performance.now() > end) throw new Error("settings-file-probe-condition-timeout");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    await nextTick();
  };
  const button = (key: string) => {
    const result = document.querySelector<HTMLButtonElement>(`#setting-${key} button`);
    if (!result) throw new Error(`settings-file-probe-button-${key}`);
    return result;
  };
  const storage = () => [
    localStorage.getItem("setting-store"),
    localStorage.getItem("shortcut-store"),
  ];
  let before: Array<string | null> = [];
  let notices = 0;
  const originals = {
    success: window.$message.success,
    error: window.$message.error,
    warning: window.$message.warning,
  };
  window.$message.success = (...args) => {
    notices++;
    return originals.success(...args);
  };
  window.$message.error = (...args) => {
    notices++;
    return originals.error(...args);
  };
  window.$message.warning = (...args) => {
    notices++;
    return originals.warning(...args);
  };
  installIsolation();
  await prepareKnownSettingsStartup();
  if (!(await prepareSurface("prepare")).passed)
    throw new Error("settings-file-probe-initial-overlay");
  const open = async () => {
    await openSetting("lyrics");
    await wait(() => Boolean(document.querySelector(".main-setting .setting-search input")));
    const target = [
      ...document.querySelectorAll<HTMLElement>(".main-setting .n-menu-item-content"),
    ].find((node) => node.textContent?.trim() === t("setting.general.general_setting"));
    if (!target) throw new Error("settings-file-probe-general-menu");
    target.click();
    await wait(() => Boolean(document.querySelector("#setting-exportSettings button")));
    await wait(() => !button("exportSettings").disabled);
    return true;
  };
  const close = async () => {
    const control = document.querySelector<HTMLElement>(".main-setting .n-base-close");
    if (!control) throw new Error("settings-file-probe-close-control");
    control.click();
    await wait(() => !document.querySelector(".main-setting .setting"));
    return true;
  };
  const startImport = async () => {
    button("importSettings").click();
    await wait(() => Boolean(document.querySelector(".n-dialog .n-button--warning-type")));
    const positive = document.querySelector<HTMLButtonElement>(".n-dialog .n-button--warning-type");
    if (!positive) throw new Error("settings-file-probe-confirm");
    positive.click();
    return true;
  };
  await open();
  return {
    startExport() {
      button("exportSettings").click();
      return true;
    },
    async disabled() {
      await wait(() => button("exportSettings").disabled && button("importSettings").disabled);
      button("exportSettings").click();
      button("importSettings").click();
      return !document.querySelector(".n-dialog");
    },
    async exported() {
      await wait(() => !button("exportSettings").disabled);
      return notices === 1;
    },
    async cancelled() {
      before = storage();
      const count = notices;
      await startImport();
      await wait(() => !button("importSettings").disabled);
      return notices === count && JSON.stringify(before) === JSON.stringify(storage());
    },
    async invalid() {
      before = storage();
      const count = notices;
      await startImport();
      await wait(() => !button("importSettings").disabled);
      return notices === count + 1 && JSON.stringify(before) === JSON.stringify(storage());
    },
    async validAndClose() {
      await startImport();
      await wait(() => {
        const a = JSON.parse(localStorage.getItem("setting-store") || "{}");
        const b = JSON.parse(localStorage.getItem("shortcut-store") || "{}");
        return a.lyricsScrollOffset === -0.25 && b.globalOpen === false && a.autoPlay === false;
      });
      if (!button("exportSettings").disabled) return false;
      await close();
      // Observe beyond the production one-second reload deadline after actual Naive leave/unmount.
      const deadline = performance.now() + 1200;
      while (performance.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return (
        !document.querySelector(".main-setting .setting") &&
        filesSession.value?.ready.value === true
      );
    },
    async lateStart() {
      await open();
      button("exportSettings").click();
      return true;
    },
    async lateClose() {
      await close();
      before = [String(notices)];
      return true;
    },
    async lateFinished() {
      await wait(() => filesSession.value?.busy.value === false);
      return String(notices) === before[0] && !document.querySelector(".main-setting .setting");
    },
    async cleanup() {
      const diagnostics = isolationDiagnostics();
      releaseIsolation();
      Object.assign(window.$message, originals);
      await platform.lifecycle?.teardown();
      return { diagnostics, startup: settingsStartupDiagnostics(), completed: true };
    },
  };
}
