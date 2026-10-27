// Imported only by the opt-in development WK probe.
import { nextTick, watch } from "vue";
import { useStatusStore } from "@/stores";

type Phase =
  | "prepare"
  | "default-pure"
  | "default-half"
  | "amll-pure"
  | "amll-half"
  | "monet-pure"
  | "monet-half";
const events = [
  "keydown",
  "keyup",
  "pointerdown",
  "pointerup",
  "click",
  "beforeinput",
  "input",
] as const;
const records: Array<Record<string, unknown>> = [];
let phase: Phase = "prepare";
let active = false;
let release: (() => void) | undefined;
let unauthorized = 0;
let dismissed = 0;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const count = (selector: string) => document.querySelectorAll(selector).length;
const snapshot = () => ({
  modals: count(".n-modal-container"),
  logins: count(".n-modal-container .login"),
  drawers: count(".n-drawer"),
  queueOpen: useStatusStore().playListShow,
  agreements: count(".n-modal-container .user-agreement"),
});

export function installIsolation() {
  if (!import.meta.env.DEV || active) throw new Error("probe-isolation-install");
  active = true;
  const previousQueue = useStatusStore().playListShow;
  const block = (event: Event) => {
    if (!event.isTrusted) return;
    const previous = records.find(
      (item) =>
        item.category === "trusted-input" && item.phase === phase && item.type === event.type,
    );
    if (previous) previous.count = Number(previous.count) + 1;
    else records.push({ category: "trusted-input", phase, type: event.type, count: 1 });
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const event of events)
    window.addEventListener(event, block, { capture: true, passive: false });
  const originalSend = XMLHttpRequest.prototype.send;
  const pending = new Map<XMLHttpRequest, () => void>();
  XMLHttpRequest.prototype.send = function (body) {
    const observe = () => {
      pending.delete(this);
      if (active && this.status === 401) {
        unauthorized++;
        records.push({ category: "anonymous-401", phase, status: 401 });
      }
    };
    pending.set(this, observe);
    this.addEventListener("loadend", observe, { once: true });
    try {
      return originalSend.call(this, body);
    } catch (error) {
      this.removeEventListener("loadend", observe);
      pending.delete(this);
      throw error;
    }
  };
  const unwatch = watch(
    () => useStatusStore().playListShow,
    (open) => {
      records.push({ category: "queue-state", phase, open });
    },
    { flush: "sync" },
  );
  release = () => {
    active = false;
    for (const [request, observe] of pending) request.removeEventListener("loadend", observe);
    pending.clear();
    for (const event of events) window.removeEventListener(event, block, true);
    XMLHttpRequest.prototype.send = originalSend;
    unwatch();
    useStatusStore().playListShow = previousQueue;
  };
}

export async function prepareSurface(nextPhase: Phase) {
  phase = nextPhase;
  if (!active) return { passed: false, phase, category: "isolation-not-installed" };
  const before = snapshot();
  let category = "no-overlay";
  if (before.modals > 0) {
    const containers = [...document.querySelectorAll(".n-modal-container")];
    const initialKnownOnly =
      phase === "prepare" &&
      before.agreements > 0 &&
      containers.every((container) => container.querySelector(".login, .user-agreement"));
    if (initialKnownOnly) {
      category = "probe-initial-state";
      window.$modal.destroyAll();
      dismissed = unauthorized;
    } else {
      // Only the known Login component's cancel control may be activated. Unknown modals fail closed.
      const cancel = document.querySelector<HTMLButtonElement>(
        ".n-modal-container .login > button.close",
      );
      if (
        containers.length !== 1 ||
        before.logins !== 1 ||
        !cancel ||
        (phase !== "prepare" && unauthorized <= dismissed)
      ) {
        const result = {
          passed: false,
          phase,
          category: "unattributed-overlay",
          before,
          after: snapshot(),
        };
        records.push(result);
        return result;
      }
      category = phase === "prepare" ? "probe-initial-state" : "anonymous-401";
      cancel.click();
      dismissed = unauthorized;
    }
  }
  useStatusStore().playListShow = false;
  await nextTick();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!count(".n-modal-container") && !count(".n-drawer")) break;
    await wait(40);
  }
  const after = snapshot();
  const result = {
    passed: after.modals === 0 && after.drawers === 0 && !after.queueOpen,
    phase,
    category,
    before,
    after,
  };
  records.push(result);
  return result;
}

export function isolationDiagnostics() {
  return { active, unauthorized, records, userGestureVerified: false };
}

export function releaseIsolation() {
  release?.();
  release = undefined;
  return !active;
}
