import { nextTick } from "vue";
import { prepareKnownSettingsStartup, settingsStartupDiagnostics } from "./settingsSurface";

interface StartupRuntime {
  documentId: string;
  errors: number;
  rejections: number;
  unknownErrors: number;
}

declare global {
  interface Window {
    __settingsStartupRuntime?: StartupRuntime;
  }
}

const phases = [
  "fade-in-scale-up-transition-enter-from",
  "fade-in-scale-up-transition-enter-active",
  "fade-in-scale-up-transition-enter-to",
  "fade-in-scale-up-transition-leave-from",
  "fade-in-scale-up-transition-leave-active",
  "fade-in-scale-up-transition-leave-to",
] as const;
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
const identity = (value: object) => {
  let id = identities.get(value);
  if (id === undefined) {
    id = ++nextIdentity;
    identities.set(value, id);
  }
  return id;
};
const snapshots: Array<Record<string, unknown>> = [];
const initialDocument = document;
let started = false;
let active = false;
let revision = 0;
let rafCount = 0;
let timerCount = 0;
let vueFlushCompleted = false;
let initialPreparationPassed = false;
let unknownFailures = 0;
let unsafeSurfaceObserved = false;
let preparationError: "unavailable" | "startup-gate-rejected" | "observation-failed" =
  "unavailable";
let observer: MutationObserver | undefined;
let raf: number | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
const events = { run: 0, end: 0, cancel: 0, animationEnd: 0 };

function nodeState(node: Element | null) {
  if (!node) return { exists: false };
  const style = getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  const bounded = (value: string) => (value.length <= 96 ? value : "unavailable");
  return {
    exists: true,
    id: identity(node),
    connected: node.isConnected,
    rect: [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 100) / 100),
    phases: phases.filter((phase) => node.classList.contains(phase)),
    display: bounded(style.display),
    visibility: bounded(style.visibility),
    opacity: bounded(style.opacity),
    transform: bounded(style.transform),
    transitionDuration: bounded(style.transitionDuration),
    transitionDelay: bounded(style.transitionDelay),
    animationDuration: bounded(style.animationDuration),
    animationDelay: bounded(style.animationDelay),
  };
}

export function startupSnapshot() {
  const containers = [...document.querySelectorAll(".n-modal-container")];
  const unknown =
    containers.filter((node) => !node.querySelector(".user-agreement,.login")).length +
    document.querySelectorAll("vite-error-overlay").length;
  const drawers = document.querySelectorAll(".n-drawer").length;
  const settings = document.querySelectorAll(".main-setting").length;
  unsafeSurfaceObserved ||= unknown > 0 || drawers > 0 || settings > 0;
  return {
    documentId: window.__settingsStartupRuntime?.documentId ?? "unavailable",
    sameDocument: document === initialDocument,
    apiId: window.$modal ? String(identity(window.$modal)) : "unavailable",
    provider: "unavailable",
    refs: "unavailable",
    show: "unavailable",
    at: performance.now(),
    revision,
    visibility: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    active,
    rafCount,
    timerCount,
    vueFlushCompleted,
    errors: window.__settingsStartupRuntime?.errors ?? null,
    rejections: window.__settingsStartupRuntime?.rejections ?? null,
    unknownErrors: window.__settingsStartupRuntime?.unknownErrors ?? null,
    modals: containers.length,
    unknown,
    drawers,
    settings,
    unsafe: unknown > 0 || drawers > 0 || settings > 0,
    empty: containers.length === 0 && unknown === 0 && drawers === 0 && settings === 0,
    nodes: containers.slice(0, 4).map((node) => ({
      kind: node.querySelector(".user-agreement")
        ? "agreement"
        : node.querySelector(".login")
          ? "login"
          : "unknown",
      container: nodeState(node),
      mask: nodeState(node.querySelector(".n-modal-mask")),
      wrapper: nodeState(node.querySelector(".n-modal-body-wrapper")),
      inner: nodeState(node.querySelector(".n-modal")),
    })),
  };
}

function sample(reason: string, automatic = true) {
  const snapshot = startupSnapshot();
  if (snapshots.length < (automatic ? 16 : 24)) snapshots.push({ reason, ...snapshot });
}

function onTransition(event: Event) {
  if (!(event.target instanceof Element) || !event.target.matches(".n-modal,.n-modal-mask")) return;
  if (!event.target.closest(".n-modal-container")) return;
  if (event.type === "transitionrun") events.run++;
  else if (event.type === "transitionend") events.end++;
  else if (event.type === "transitioncancel") events.cancel++;
  else events.animationEnd++;
  revision++;
  sample("transition-event");
}

export function stopStartupObservation() {
  active = false;
  observer?.disconnect();
  if (raf !== undefined) cancelAnimationFrame(raf);
  if (timer !== undefined) clearInterval(timer);
  if (watchdog !== undefined) clearTimeout(watchdog);
  for (const type of ["transitionrun", "transitionend", "transitioncancel", "animationend"])
    document.removeEventListener(type, onTransition, true);
  window.removeEventListener("pagehide", stopStartupObservation);
  sample("cleanup", false);
}

/** DEV fileprobe only: observes startup without replacing frame or transition behavior. */
export async function observeSettingsStartup() {
  if (!import.meta.env.DEV || started || !window.__settingsStartupRuntime)
    throw new Error("settings-startup-observation-guard");
  started = true;
  active = true;
  try {
    sample("before-preparation");
    observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (record.target instanceof Element && record.target.closest(".n-modal-container"))
          return true;
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches(".n-modal-container,.n-drawer,.main-setting,vite-error-overlay") ||
              Boolean(
                node.querySelector(".n-modal-container,.n-drawer,.main-setting,vite-error-overlay"),
              )),
        );
      });
      if (relevant) {
        revision++;
        sample("surface-mutation");
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    for (const type of ["transitionrun", "transitionend", "transitioncancel", "animationend"])
      document.addEventListener(type, onTransition, true);
    window.addEventListener("pagehide", stopStartupObservation, { once: true });
    const frame = () => {
      rafCount++;
      sample("own-raf");
      if (active && rafCount < 4) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    timer = setInterval(() => {
      timerCount++;
      if (timerCount <= 4) sample("own-timer");
      if (timerCount >= 60 && timer !== undefined) clearInterval(timer);
    }, 100);
    watchdog = setTimeout(stopStartupObservation, 6500);
    void nextTick().then(() => {
      if (active) {
        vueFlushCompleted = true;
        sample("vue-flush");
      }
    });
    await prepareKnownSettingsStartup();
    initialPreparationPassed = true;
  } catch (error) {
    const guards = [
      "settings-file-probe-startup-only",
      "settings-file-probe-unknown-startup-overlay",
      "settings-file-probe-new-unknown-startup-overlay",
      "settings-file-probe-startup-leave-timeout",
    ];
    const known = error instanceof Error && guards.includes(error.message);
    preparationError = known ? "startup-gate-rejected" : "observation-failed";
    if (!known) unknownFailures++;
    stopStartupObservation();
  } finally {
    sample("long-eval-return", false);
  }
  return readStartupObservation();
}

export function readStartupObservation() {
  const current = startupSnapshot();
  const runtime = window.__settingsStartupRuntime;
  const countersValid =
    runtime !== undefined &&
    [runtime.errors, runtime.rejections, runtime.unknownErrors].every(
      (value) => Number.isInteger(value) && value >= 0,
    );
  const finalSurfaceSafe =
    countersValid &&
    current.sameDocument &&
    current.empty &&
    !current.unsafe &&
    !unsafeSurfaceObserved &&
    current.errors === 0 &&
    current.rejections === 0 &&
    current.unknownErrors === 0 &&
    unknownFailures === 0;
  return {
    initialPreparationPassed,
    finalSurfaceSafe,
    preparationError,
    unknownFailures,
    unsafeSurfaceObserved,
    startupRecords: settingsStartupDiagnostics(),
    events: { ...events },
    snapshots: [...snapshots],
    current,
  };
}
