import { computed, shallowRef } from "vue";
import type { PlatformUpdates, UpdatesEvent, UpdatesState } from "./updates";

let requestSequence = 0;
function requestID(): number {
  if (requestSequence >= Number.MAX_SAFE_INTEGER) throw new Error("Update request IDs exhausted");
  return ++requestSequence;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

type Operation = "check" | "install" | "state" | "restart";
interface Pending {
  id: number;
  operation: Operation;
  revision: number;
  result: ReturnType<typeof deferred<UpdatesState>>;
  acknowledged?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
type OperationRequest = Pick<Pending, "id" | "operation" | "revision">;
export interface UpdatesSessionOptions {
  acknowledgementTimeoutMs?: number;
  operationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}
const activeSession = shallowRef<UpdatesSession>();
export const updatesSession = computed(() => activeSession.value);

/** Commands are acknowledged by matching native events, never by RPC resolution. */
export class UpdatesSession {
  private readonly native = shallowRef<UpdatesState>();
  private readonly available = shallowRef(false);
  private readonly waiting = shallowRef<Pending>();
  private readonly uncertainInstall = shallowRef(false);
  readonly state = computed(() => this.native.value);
  readonly ready = computed(() => this.available.value);
  readonly busy = computed(
    () =>
      Boolean(this.waiting.value) ||
      this.uncertainInstall.value ||
      !!this.native.value?.installBusy,
  );
  private readonly acknowledgementTimeout: number;
  private readonly operationTimeout: number;
  private readonly cleanupTimeout: number;
  private off?: () => void;
  private beginID?: number;
  private beginResult?: ReturnType<typeof deferred<void>>;
  private beginTimer?: ReturnType<typeof setTimeout>;
  private beginAcknowledged = false;
  private beginQueued = false;
  private epoch?: number;
  private revision = 0;
  private last?: OperationRequest;
  private nativeOperation?: OperationRequest;
  private closed = false;
  private starting?: Promise<void>;
  private cleaning?: ReturnType<typeof deferred<void>>;
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private teardownSent = false;

  constructor(
    private readonly provider: PlatformUpdates,
    options: UpdatesSessionOptions = {},
  ) {
    this.acknowledgementTimeout = options.acknowledgementTimeoutMs ?? 5_000;
    this.operationTimeout = options.operationTimeoutMs ?? 1_900_000;
    this.cleanupTimeout = options.cleanupTimeoutMs ?? 5_000;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Update session ended"));
    if (this.starting) return this.starting;
    const result = deferred<void>();
    this.beginResult = result;
    this.starting = result.promise;
    this.beginID = requestID();
    try {
      this.off = this.provider.onChange((event) => this.receive(event));
      this.beginTimer = setTimeout(
        () => this.failStart("Update session acknowledgement timed out"),
        this.acknowledgementTimeout,
      );
      void this.provider.begin(this.beginID).then(
        () => {
          this.beginQueued = true;
          this.finishStart();
        },
        () => this.failStart("Update session could not be started"),
      );
    } catch {
      this.failStart("Update session could not be started");
    }
    return result.promise;
  }

  check(): Promise<UpdatesState> {
    return this.run("check");
  }
  install(): Promise<UpdatesState> {
    const state = this.native.value;
    if (state?.phase !== "available" || state.installBusy || this.uncertainInstall.value) {
      return Promise.reject(new Error("Update candidate is unavailable"));
    }
    return this.run("install");
  }
  restart(): Promise<UpdatesState> {
    if (this.native.value?.phase !== "installed" || this.busy.value) {
      return Promise.reject(new Error("Installed update is unavailable"));
    }
    return this.run("restart");
  }
  refresh(): Promise<UpdatesState> {
    return this.run("state");
  }
  cancelCheck(): Promise<void> {
    return this.waiting.value?.operation === "check" ? this.dispose() : Promise.resolve();
  }

  dispose(): Promise<void> {
    if (this.cleaning) return this.cleaning.promise;
    this.closed = true;
    this.available.value = false;
    if (activeSession.value === this) activeSession.value = undefined;
    this.native.value = undefined;
    this.settlePending(undefined, "Update session ended");
    this.uncertainInstall.value = false;
    this.beginResult?.reject(new Error("Update session ended"));
    clearTimeout(this.beginTimer);
    this.beginTimer = undefined;
    this.cleaning = deferred<void>();
    this.cleanupTimer = setTimeout(() => this.finishCleanup(), this.cleanupTimeout);
    if (this.epoch !== undefined) this.sendTeardown(this.epoch);
    else if (this.beginID === undefined || !this.off) this.finishCleanup();
    // A bounded listener remains for a late Begin ack, to teardown its exact
    // epoch. It never reactivates this instance or claims another instance's ack.
    return this.cleaning.promise;
  }

  private run(operation: Operation): Promise<UpdatesState> {
    if (!this.available.value || this.closed || this.epoch === undefined) {
      return Promise.reject(new Error("Update session is unavailable"));
    }
    if (this.waiting.value || (operation !== "state" && this.uncertainInstall.value)) {
      return Promise.reject(new Error("Update operation is still pending"));
    }
    if (operation !== "state") {
      this.revision = Math.max(this.revision, this.native.value?.operationRevision ?? 0) + 1;
      if (!Number.isSafeInteger(this.revision))
        return Promise.reject(new Error("Update revision exhausted"));
    }
    const pending: Pending = {
      id: requestID(),
      operation,
      revision: this.revision,
      result: deferred<UpdatesState>(),
    };
    this.waiting.value = pending;
    this.last = pending;
    if (operation !== "state") this.nativeOperation = pending;
    if (operation === "install") this.uncertainInstall.value = true;
    pending.timer = setTimeout(() => {
      if (this.waiting.value === pending)
        this.settlePending(undefined, "Update operation timed out");
    }, this.acknowledgementTimeout);
    try {
      const rpc =
        operation === "state"
          ? this.provider.getState(pending.id, this.epoch)
          : this.provider[operation](pending.id, this.epoch, pending.revision);
      void rpc.catch(() => {
        if (this.waiting.value === pending)
          this.settlePending(undefined, "Update command could not be delivered");
      });
    } catch {
      this.settlePending(undefined, "Update command could not be delivered");
    }
    return pending.result.promise;
  }

  private receive(event: UpdatesEvent): void {
    const state = event.state;
    if (!Number.isSafeInteger(state.epoch) || state.epoch <= 0) return;
    if (event.requestId === this.beginID && !this.beginAcknowledged) {
      this.beginAcknowledged = true;
      this.epoch = state.epoch;
      if (this.closed) {
        this.sendTeardown(state.epoch);
      } else if (event.code) {
        this.failStart("Update session was rejected");
      } else {
        if (!this.merge(state)) {
          this.failStart("Invalid update session state");
          return;
        }
        this.finishStart();
      }
      return;
    }
    if (this.closed || state.epoch !== this.epoch) return;
    const last = event.requestId === this.nativeOperation?.id ? this.nativeOperation : this.last;
    if (event.requestId !== 0 && event.requestId !== last?.id) return;
    const pending = this.waiting.value;
    // Rejections do not consume the requested operation revision. A matching
    // error ack must settle even when its snapshot still has the older revision.
    if (event.code && pending?.id === event.requestId) {
      const merged = this.merge(state);
      if (
        merged &&
        pending.operation === "install" &&
        !state.installBusy &&
        state.phase !== "installing"
      )
        this.uncertainInstall.value = false;
      this.settlePending(undefined, event.code);
      return;
    }
    if (
      event.requestId !== 0 &&
      last?.operation !== "state" &&
      state.operationRevision !== last?.revision
    )
      return;
    if (!this.merge(state)) return;
    if (event.requestId === 0) return;
    if (last?.operation === "state" && !state.installBusy && state.phase !== "installing") {
      this.uncertainInstall.value = false;
    }
    if (last?.operation === "install" && !state.installBusy && state.phase !== "installing")
      this.uncertainInstall.value = false;
    if (!pending || pending.id !== event.requestId) return;
    if (!pending.acknowledged && pending.operation !== "state") {
      pending.acknowledged = true;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        if (this.waiting.value === pending)
          this.settlePending(undefined, "Update operation timed out");
      }, this.operationTimeout);
    }
    if (pending.operation === "check" && state.phase === "checking") return;
    if (pending.operation === "install" && state.phase === "installing") return;
    this.settlePending(state);
  }

  private merge(state: UpdatesState): boolean {
    const previous = this.native.value;
    if (
      !Number.isSafeInteger(state.stateRevision) ||
      state.stateRevision <= 0 ||
      !Number.isSafeInteger(state.operationRevision) ||
      state.operationRevision < 0 ||
      (previous &&
        (state.stateRevision < previous.stateRevision ||
          state.operationRevision < previous.operationRevision))
    )
      return false;
    this.native.value = state;
    return true;
  }
  private finishStart(): void {
    if (this.closed || !this.beginAcknowledged || !this.beginQueued || this.available.value) return;
    clearTimeout(this.beginTimer);
    this.beginTimer = undefined;
    this.available.value = true;
    activeSession.value = this;
    this.beginResult?.resolve();
  }
  private failStart(message: string): void {
    if (this.closed || this.available.value) return;
    this.beginResult?.reject(new Error(message));
    void this.dispose();
  }
  private settlePending(state?: UpdatesState, error?: string): void {
    const pending = this.waiting.value;
    if (!pending) return;
    this.waiting.value = undefined;
    clearTimeout(pending.timer);
    if (error) pending.result.reject(new Error(error));
    else if (state) pending.result.resolve(state);
  }
  private sendTeardown(epoch: number): void {
    if (this.teardownSent) return;
    this.teardownSent = true;
    try {
      void this.provider.teardown(requestID(), epoch).then(
        () => this.finishCleanup(),
        () => this.finishCleanup(),
      );
    } catch {
      this.finishCleanup();
    }
  }
  private finishCleanup(): void {
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    try {
      this.off?.();
    } catch {
      // A failing unsubscribe must not strand shell disposal.
    }
    this.off = undefined;
    this.cleaning?.resolve();
  }
}
