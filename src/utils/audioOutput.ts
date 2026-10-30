interface SinkTarget {
  setSinkId?(deviceId: string): Promise<void>;
}

interface StreamOutput {
  readonly destination: MediaStreamAudioDestinationNode;
  readonly element: HTMLAudioElement;
  pendingPlay?: Promise<void>;
  disposed: boolean;
  onError: EventListener;
}

interface OutputSource {
  readonly element: HTMLAudioElement;
  readonly context?: AudioContext | null;
  readonly node?: AudioNode | null;
  sinkId: string;
  queue: Promise<void>;
  cleanup(): void;
  bridge?: StreamOutput;
  candidate?: StreamOutput;
}

/** Owns physical output routing; the source element remains the playback clock. */
export class AudioOutputRouter {
  private source?: OutputSource;
  private desiredSinkId = "";
  private confirmedSinkId = "";
  private revision = 0;
  private wantsPlay = false;
  private readonly appliedSinks = new WeakMap<object, string>();

  constructor(private readonly createElement: () => HTMLAudioElement = () => new Audio()) {}

  setSource(
    element: HTMLAudioElement | null,
    context?: AudioContext | null,
    node?: AudioNode | null,
  ): void {
    context ??= null;
    node ??= null;
    const previous = this.source;
    if (previous?.element === element && previous?.context === context && previous?.node === node)
      return;
    this.source = undefined;
    this.wantsPlay = false;
    if (previous) {
      previous.cleanup();
      if (previous.context?.state !== "closed") this.restoreDefault(previous);
      this.releaseBridge(previous, previous.candidate);
      this.releaseBridge(previous, previous.bridge);
    }
    if (!element) return;
    const pause = () => this.pause();
    element.addEventListener("pause", pause);
    element.addEventListener("ended", pause);
    this.source = {
      element,
      context,
      node,
      sinkId: this.appliedSinks.get(context ?? element) ?? "",
      queue: Promise.resolve(),
      cleanup: () => {
        element.removeEventListener("pause", pause);
        element.removeEventListener("ended", pause);
      },
    };
  }

  async setSinkId(deviceId: string): Promise<void> {
    const revision = ++this.revision;
    this.desiredSinkId = deviceId === "default" ? "" : deviceId;
    try {
      await this.refresh();
    } catch (error) {
      if (revision === this.revision) this.desiredSinkId = this.confirmedSinkId;
      throw error;
    }
  }

  refresh(): Promise<void> {
    const source = this.source;
    if (!source) return Promise.resolve();
    const desired = this.desiredSinkId;
    const operation = source.queue.then(async () => {
      if (source !== this.source || desired !== this.desiredSinkId) return;
      await this.route(source, desired);
    });
    source.queue = operation.catch(() => undefined);
    return operation;
  }

  async play(): Promise<void> {
    const source = this.source;
    this.wantsPlay = true;
    let routingError: unknown;
    try {
      await this.refresh();
    } catch (error) {
      routingError = error;
    }
    if (source !== this.source || !this.wantsPlay) return;
    if (!source?.bridge) {
      if (routingError) throw routingError;
      return;
    }
    try {
      await this.startBridge(source, source.bridge);
    } catch (error) {
      // A blocked stream renderer must not leave the source playing into silence.
      if (source === this.source && source.bridge && this.wantsPlay) {
        this.restoreDefault(source);
        this.confirm(source, "");
      }
      throw error;
    }
    if (routingError) throw routingError;
  }

  pause(): void {
    this.wantsPlay = false;
    this.source?.bridge?.element.pause();
    this.source?.candidate?.element.pause();
  }

  private confirm(source: OutputSource, sinkId: string): void {
    source.sinkId = sinkId;
    if (source === this.source) this.confirmedSinkId = sinkId;
  }

  private async route(source: OutputSource, desired: string): Promise<void> {
    if (source.sinkId === desired) {
      this.confirm(source, desired);
      return;
    }
    const context: (AudioContext & SinkTarget) | null | undefined = source.context;
    if (!context || typeof context.setSinkId === "function") {
      const target: SinkTarget = context ?? source.element;
      if (typeof target.setSinkId !== "function") throw unsupportedOutput();
      await target.setSinkId(desired);
      this.appliedSinks.set(context ?? source.element, desired);
      this.confirm(source, desired);
      return;
    }
    if (desired === "") {
      this.restoreDefault(source);
      this.confirm(source, "");
      return;
    }
    if (source.bridge) {
      const bridge = source.bridge;
      await bridge.element.setSinkId(desired);
      if (source !== this.source || source.bridge !== bridge || bridge.disposed) return;
      this.confirm(source, desired);
      return;
    }
    if (!source.node || typeof context.createMediaStreamDestination !== "function")
      throw unsupportedOutput();

    const element = this.createElement();
    if (typeof element.setSinkId !== "function") throw unsupportedOutput();
    const destination = context.createMediaStreamDestination();
    const bridge: StreamOutput = {
      element,
      destination,
      disposed: false,
      onError: () => {
        if (source !== this.source || source.bridge !== bridge) return;
        this.restoreDefault(source);
        this.confirm(source, "");
        console.error("Audio output stream failed; restored system default");
      },
    };
    element.addEventListener("error", bridge.onError);
    source.candidate = bridge;
    try {
      // Warm the candidate while the original destination keeps playing. Muting
      // prevents duplicate output; the gain node still applies volume exactly once.
      element.volume = 1;
      element.muted = true;
      element.srcObject = destination.stream;
      source.node.connect(destination);
      await element.setSinkId(desired);
      if (!this.ownsCandidate(source, bridge, desired)) return;
      if (this.wantsPlay) await this.startBridge(source, bridge);
      if (!this.ownsCandidate(source, bridge, desired)) return;
      source.node.disconnect(context.destination);
      source.bridge = bridge;
      source.candidate = undefined;
      element.muted = false;
      this.confirm(source, desired);
    } finally {
      if (source.bridge !== bridge) this.releaseBridge(source, bridge);
    }
  }

  private ownsCandidate(source: OutputSource, bridge: StreamOutput, desired: string): boolean {
    return (
      source === this.source &&
      source.candidate === bridge &&
      !bridge.disposed &&
      desired === this.desiredSinkId
    );
  }

  private async startBridge(source: OutputSource, bridge: StreamOutput): Promise<void> {
    if (bridge.disposed || !this.wantsPlay) return;
    if (!bridge.pendingPlay && bridge.element.paused) {
      bridge.pendingPlay = bridge.element.play();
    }
    const pending = bridge.pendingPlay;
    try {
      await pending;
    } catch (error) {
      if (this.wantsPlay && source === this.source && !bridge.disposed) throw error;
    } finally {
      if (bridge.pendingPlay === pending) bridge.pendingPlay = undefined;
      if (bridge.disposed || source !== this.source || !this.wantsPlay) bridge.element.pause();
    }
  }

  private restoreDefault(source: OutputSource): void {
    if (!source.bridge || !source.node || !source.context) return;
    const bridge = source.bridge;
    bridge.element.muted = true;
    try {
      source.node.connect(source.context.destination);
    } catch (error) {
      bridge.element.muted = false;
      throw error;
    }
    source.bridge = undefined;
    this.releaseBridge(source, bridge);
  }

  private releaseBridge(source: OutputSource, bridge?: StreamOutput): void {
    if (!bridge || bridge.disposed) return;
    bridge.disposed = true;
    if (source.candidate === bridge) source.candidate = undefined;
    if (source.bridge === bridge) source.bridge = undefined;
    bridge.element.removeEventListener("error", bridge.onError);
    bridge.element.pause();
    bridge.element.srcObject = null;
    try {
      source.node?.disconnect(bridge.destination);
    } catch {
      // The source graph may already have disconnected all its nodes.
    }
    bridge.destination.stream.getTracks().forEach((track) => track.stop());
    bridge.destination.disconnect();
  }
}

function unsupportedOutput(): DOMException {
  return new DOMException(
    "This audio output does not support device selection",
    "NotSupportedError",
  );
}
