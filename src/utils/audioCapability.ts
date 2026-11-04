import { isMygoGatewayResourceUrl } from "@/platform/gateway";

export type AudioSourceAccess = "native" | "web-audio";

export interface AudioSourceInfo {
  readonly platform: string;
  readonly format: string;
}

export interface AudioSourceProbeOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Checks whether a media URL can be read by a Web Audio MediaElementSource.
 * A ranged GET is used because HEAD does not exercise the CORS path used by media.
 * The response body is cancelled immediately; this helper never preloads a track.
 */
export async function canUseWebAudioSource(
  url: string,
  options: AudioSourceProbeOptions = {},
): Promise<boolean> {
  if (!/^https?:\/\//i.test(url) || options.signal?.aborted) return false;
  // The native proxy already guarantees CORS. A second ranged upstream fetch
  // delays every track and may compete with WebKitGTK's actual media request.
  if (isMygoGatewayResourceUrl(url)) return true;
  // These Kuwo media responses allow ordinary playback but reject CORS reads.
  // Avoid a known-to-fail browser fetch; keep other sources eligible for processing.
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "kw-lv.kuwo.cn") return false;
  } catch {
    return false;
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") return false;

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await boundedProbe(
      async () => {
        const response = await fetcher(url, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        void response.body?.cancel().catch(() => undefined);
        return response.ok && !controller.signal.aborted;
      },
      controller,
      options.timeoutMs ?? 3000,
    );
    return response;
  } catch {
    return false;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export interface AudioGraphLease {
  readonly context: AudioContext;
  readonly source: MediaElementAudioSourceNode;
  readonly analyser: AnalyserNode;
  readonly gain: GainNode;
  readonly filters: readonly BiquadFilterNode[];
  dispose(): void;
}

export interface AudioGraphOptions {
  frequencies: readonly number[];
  volume: number;
  contextFactory?: () => AudioContext;
}

/** Creates the one graph shared by EQ and spectrum consumers. */
export function createAudioGraph(
  element: HTMLAudioElement,
  options: AudioGraphOptions,
): AudioGraphLease {
  const context = (options.contextFactory ?? (() => new AudioContext()))();
  let source: MediaElementAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let gain: GainNode | undefined;
  const filters: BiquadFilterNode[] = [];

  try {
    source = context.createMediaElementSource(element);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    gain = context.createGain();
    gain.gain.value = clampVolume(options.volume);
    for (const frequency of options.frequencies) {
      const filter = context.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = frequency;
      filter.Q.value = 1;
      filter.gain.value = 0;
      filters.push(filter);
    }

    let current: AudioNode = source;
    for (const filter of filters) {
      current.connect(filter);
      current = filter;
    }
    current.connect(analyser);
    analyser.connect(gain);
    gain.connect(context.destination);
  } catch (error) {
    disposeNodes(source, analyser, gain, filters);
    void closeContext(context);
    throw error;
  }

  let disposed = false;
  return {
    context,
    source,
    analyser,
    gain,
    filters,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeNodes(source, analyser, gain, filters);
      void closeContext(context);
    },
  };
}

function disposeNodes(
  source: AudioNode | undefined,
  analyser: AudioNode | undefined,
  gain: AudioNode | undefined,
  filters: readonly AudioNode[],
): void {
  for (const node of [source, ...filters, analyser, gain]) {
    try {
      node?.disconnect();
    } catch {
      // Continue releasing the other nodes and closing the context.
    }
  }
}

async function closeContext(context: AudioContext): Promise<void> {
  if (context.state !== "closed") {
    try {
      await context.close();
    } catch {
      // A context may already be closed by the platform during teardown.
    }
  }
}

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Monotonic source token used to reject late probe/graph results. */
export class AudioSourceGeneration {
  private value = 0;

  get current(): number {
    return this.value;
  }

  next(): number {
    this.value += 1;
    return this.value;
  }

  revoke(): number {
    return this.next();
  }

  isCurrent(generation: number): boolean {
    return generation === this.value;
  }
}

async function boundedProbe(
  probe: () => Promise<boolean>,
  controller: AbortController,
  timeoutMs: number,
): Promise<boolean> {
  if (controller.signal.aborted) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const cancelled = new Promise<boolean>((resolve) => {
    abort = () => resolve(false);
    controller.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(probe)
        .catch(() => false),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
  }
}

export interface AudioProcessingDriverOptions {
  createElement: () => HTMLAudioElement;
  frequencies: readonly number[];
  volume?: number;
  probeTimeoutMs?: number;
  prepareOutput?: (element: HTMLAudioElement, context: AudioContext | undefined) => Promise<void>;
  probe?: (url: string, signal: AbortSignal) => Promise<boolean>;
  createGraph?: (element: HTMLAudioElement, options: AudioGraphOptions) => AudioGraphLease;
}

const mediaEvents = [
  "play",
  "playing",
  "pause",
  "ended",
  "timeupdate",
  "error",
  "waiting",
  "stalled",
  "canplay",
  "loadedmetadata",
  "loadstart",
  "volumechange",
  "seeking",
  "seeked",
] as const;
export type AudioDriverEvent = (typeof mediaEvents)[number] | "processingchange";

function isPolicyError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotAllowedError";
}

interface AudioPlayOperation {
  readonly generation: number;
  readonly revision: number;
  element: HTMLAudioElement;
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

/** A graph-bound element is discarded permanently; the plain element is never captured. */
export class AudioProcessingDriver {
  private plainElement: HTMLAudioElement;
  private graph: AudioGraphLease | undefined;
  private activeElement: HTMLAudioElement;
  private readonly generation = new AudioSourceGeneration();
  private probeController: AbortController | undefined;
  private volume: number;
  private rate = 1;
  private listeners = new Map<AudioDriverEvent, Set<(event: Event) => void>>();
  private activeCleanup: (() => void) | undefined;
  private seekCleanup: (() => void) | undefined;
  private pendingSeek: { element: HTMLAudioElement; position: number } | undefined;
  private currentUrl = "";
  private sourceInfo: AudioSourceInfo | undefined;
  private sourceError = false;
  private sourceNode:
    { element: HTMLAudioElement; source: HTMLSourceElement; onError: EventListener } | undefined;
  private disposed = false;
  private playRevision = 0;
  private wantsPlay = false;
  private pendingPlay: AudioPlayOperation | undefined;

  constructor(private readonly options: AudioProcessingDriverOptions) {
    this.plainElement = options.createElement();
    this.activeElement = this.plainElement;
    this.volume = clampVolume(options.volume ?? 1);
    this.activate(this.plainElement, this.loadGeneration);
  }

  get element(): HTMLAudioElement {
    return this.activeElement;
  }
  get source(): string {
    return this.currentUrl;
  }
  get errorCode(): number {
    return this.activeElement.error?.code ?? (this.sourceError ? 4 : 0);
  }
  /** Capture immediately after load(); a native result alone does not prove currency. */
  get loadGeneration(): number {
    return this.generation.current;
  }
  /** A pause changes this receipt without cancelling a pending preload. */
  get playIntentGeneration(): number {
    return this.playRevision;
  }
  get processingAvailable(): boolean {
    return this.graph !== undefined;
  }
  get context(): AudioContext | undefined {
    return this.graph?.context;
  }
  get gain(): GainNode | undefined {
    return this.graph?.gain;
  }
  get analyser(): AnalyserNode | undefined {
    return this.graph?.analyser;
  }
  get filters(): readonly BiquadFilterNode[] {
    return this.graph?.filters ?? [];
  }

  isCurrent(generation: number): boolean {
    return !this.disposed && this.generation.isCurrent(generation);
  }

  async load(url: string, sourceInfo?: AudioSourceInfo): Promise<AudioSourceAccess> {
    if (this.disposed) throw new Error("Audio driver is disposed");
    const generation = this.generation.next();
    this.cancelPendingPlay();
    const previousProbe = this.probeController;
    const controller = new AbortController();
    this.probeController = controller;
    previousProbe?.abort();
    this.stopCurrent(generation);
    if (!this.isCurrent(generation)) return "native";
    const probe =
      this.options.probe ?? ((source, signal) => canUseWebAudioSource(source, { signal }));
    const shouldProcess = await boundedProbe(
      () => probe(url, controller.signal),
      controller,
      this.options.probeTimeoutMs ?? 3000,
    );
    controller.abort();
    if (this.probeController === controller) this.probeController = undefined;
    if (!this.isCurrent(generation)) return "native";

    if (shouldProcess) {
      const element = this.options.createElement();
      element.crossOrigin = "anonymous";
      let graph: AudioGraphLease | undefined;
      try {
        graph = (this.options.createGraph ?? createAudioGraph)(element, {
          frequencies: this.options.frequencies,
          volume: this.volume,
        });
      } catch {
        this.releaseElement(element, generation);
      }
      if (!this.isCurrent(generation)) {
        graph?.dispose();
        this.releaseElement(element, generation);
        return "native";
      }
      if (graph) {
        this.graph = graph;
        this.activate(element, generation);
        if (!this.matches(generation, element)) return "native";
        this.emit("processingchange", new Event("processingchange"));
        if (this.matches(generation, element))
          this.assignSource(element, url, generation, sourceInfo);
        return this.matches(generation, element) && this.graph ? "web-audio" : "native";
      }
    }
    if (!this.isCurrent(generation)) return "native";
    this.activate(this.plainElement, generation);
    if (this.matches(generation, this.plainElement)) {
      this.plainElement.crossOrigin = null;
      this.assignSource(this.plainElement, url, generation, sourceInfo);
    }
    return "native";
  }

  play(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Audio driver is disposed"));
    this.cancelPendingPlay();
    this.wantsPlay = true;
    const operation = this.createPlayOperation(this.activeElement);
    void this.runPlay(operation, operation.element, this.graph);
    return operation.promise;
  }

  private createPlayOperation(element: HTMLAudioElement): AudioPlayOperation {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const operation = {
      generation: this.loadGeneration,
      revision: this.playRevision,
      element,
      promise,
      resolve,
      reject,
    };
    this.pendingPlay = operation;
    return operation;
  }

  private ownsPlay(operation: AudioPlayOperation, element: HTMLAudioElement): boolean {
    return (
      this.pendingPlay === operation &&
      operation.element === element &&
      this.wantsPlay &&
      this.playRevision === operation.revision &&
      this.matches(operation.generation, element)
    );
  }

  private finishPlay(operation: AudioPlayOperation, error?: unknown): void {
    if (this.pendingPlay !== operation) return;
    this.pendingPlay = undefined;
    if (error !== undefined) {
      this.wantsPlay = false;
      operation.reject(error);
    } else operation.resolve();
  }

  private async runPlay(
    operation: AudioPlayOperation,
    element: HTMLAudioElement,
    graph?: AudioGraphLease,
  ): Promise<void> {
    if (graph?.context.state === "suspended") {
      try {
        await graph.context.resume();
      } catch (error) {
        if (!this.ownsPlay(operation, element)) return;
        if (isPolicyError(error)) this.finishPlay(operation, error);
        else this.recoverPlayback(operation.generation, element);
        return;
      }
    }
    if (!this.ownsPlay(operation, element)) return;
    try {
      if (this.options.prepareOutput) {
        try {
          await this.options.prepareOutput(element, graph?.context);
        } catch {
          // Output routing is best effort; the owner may still be played.
        }
        if (!this.ownsPlay(operation, element)) return;
      }
      await element.play();
    } catch (error) {
      // The same operation may already belong to a successful/pending plain fallback.
      if (this.ownsPlay(operation, element)) this.finishPlay(operation, error);
      return;
    }
    if (this.ownsPlay(operation, element)) this.finishPlay(operation);
    else if (element !== this.activeElement || !this.wantsPlay) element.pause();
  }

  /** Revoke pending starts/restarts without interrupting an already playing fade-out owner. */
  cancelPendingPlay(): number {
    this.wantsPlay = false;
    this.playRevision += 1;
    const operation = this.pendingPlay;
    this.pendingPlay = undefined;
    operation?.resolve();
    return this.playRevision;
  }

  pause(): void {
    this.cancelPendingPlay();
    this.activeElement.pause();
  }

  private recoverPlayback(generation: number, element: HTMLAudioElement): void {
    const revision = this.playRevision;
    const operation = this.pendingPlay;
    this.fallbackToPlain(generation, element);
    const plain = this.activeElement;
    if (
      !this.wantsPlay ||
      this.playRevision !== revision ||
      !this.matches(generation, plain) ||
      plain !== this.plainElement
    )
      return;
    if (operation && this.pendingPlay === operation) {
      operation.element = plain;
      void this.runPlay(operation, plain);
    } else if (!operation && !this.pendingPlay) {
      const background = this.createPlayOperation(plain);
      void background.promise.catch((error: unknown) => {
        if (
          !isPolicyError(error) &&
          this.playRevision === revision &&
          this.matches(generation, plain)
        )
          this.emit("error", new Event("error"));
      });
      void this.runPlay(background, plain);
    }
  }

  setVolume(value: number): void {
    this.volume = clampVolume(value);
    if (this.graph) {
      const { context, gain } = this.graph;
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(this.volume, context.currentTime);
    }
    this.activeElement.volume = this.graph ? 1 : this.volume;
  }
  setRate(value: number): void {
    this.rate = value;
    const element = this.activeElement;
    element.defaultPlaybackRate = value;
    if (element === this.activeElement) element.playbackRate = value;
  }
  seek(value: number): void {
    this.restorePosition(this.activeElement, this.loadGeneration, value);
  }
  on(event: AudioDriverEvent, listener: (event: Event) => void): void {
    if (this.disposed) return;
    const listeners = this.listeners.get(event) ?? new Set<(event: Event) => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: AudioDriverEvent, listener: (event: Event) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  offAll(): void {
    this.listeners.clear();
  }

  clearSource(): void {
    const generation = this.generation.revoke();
    this.cancelPendingPlay();
    const controller = this.probeController;
    this.probeController = undefined;
    controller?.abort();
    this.stopCurrent(generation);
    if (this.isCurrent(generation)) this.activate(this.plainElement, generation);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSource();
    this.generation.revoke();
    this.activeCleanup?.();
    this.activeCleanup = undefined;
    this.offAll();
  }

  private matches(generation: number, element: HTMLAudioElement): boolean {
    return this.isCurrent(generation) && this.activeElement === element;
  }
  private activate(element: HTMLAudioElement, generation: number): void {
    this.activeCleanup?.();
    this.activeElement = element;
    const handlers = new Map<string, EventListener>();
    for (const event of mediaEvents) {
      const handler: EventListener = (mediaEvent) => {
        if (!this.matches(generation, element)) return;
        if (event === "error" && this.sourceNode?.element === element) {
          if (this.sourceError) return;
          this.sourceError = true;
        }
        if (event === "error" && this.graph) {
          this.recoverPlayback(generation, element);
        } else {
          this.emit(event, mediaEvent);
        }
      };
      handlers.set(event, handler);
      element.addEventListener(event, handler);
    }
    this.activeCleanup = () => {
      handlers.forEach((handler, event) => element.removeEventListener(event, handler));
    };
    element.volume = this.graph ? 1 : this.volume;
    if (!this.matches(generation, element)) return;
    element.defaultPlaybackRate = this.rate;
    if (this.matches(generation, element)) element.playbackRate = this.rate;
  }
  private assignSource(
    element: HTMLAudioElement,
    url: string,
    generation: number,
    sourceInfo?: AudioSourceInfo,
  ): void {
    if (!this.matches(generation, element)) return;
    this.currentUrl = url;
    this.sourceInfo = sourceInfo;
    this.sourceError = false;
    this.removeSourceNode(element);
    const sourceType =
      sourceInfo?.format === "flac"
        ? "audio/flac"
        : sourceInfo?.platform === "migu" && sourceInfo.format === "m4a"
          ? "audio/mp4"
          : undefined;
    if (sourceType) {
      // Safari needs the container MIME hint for this resource. A parent src takes precedence.
      element.removeAttribute("src");
      if (!this.matches(generation, element)) return;
      const source = element.ownerDocument.createElement("source");
      const onError: EventListener = (event) => {
        if (
          !this.matches(generation, element) ||
          this.sourceNode?.source !== source ||
          this.sourceError
        )
          return;
        this.sourceError = true;
        if (this.graph) this.recoverPlayback(generation, element);
        else this.emit("error", event);
      };
      source.type = sourceType;
      source.src = url;
      source.addEventListener("error", onError);
      this.sourceNode = { element, source, onError };
      element.appendChild(source);
    } else {
      element.src = url;
    }
    if (this.matches(generation, element)) element.load();
  }
  private removeSourceNode(element: HTMLAudioElement): void {
    const node = this.sourceNode;
    if (node?.element !== element) return;
    this.sourceNode = undefined;
    node.source.removeEventListener("error", node.onError);
    node.source.remove();
  }
  private releaseElement(element: HTMLAudioElement, generation: number): void {
    element.pause();
    if (element === this.activeElement && !this.generation.isCurrent(generation)) return;
    this.removeSourceNode(element);
    // removeAttribute avoids turning an empty src into a request for the current page.
    element.removeAttribute("src");
    if (element === this.activeElement && !this.generation.isCurrent(generation)) return;
    element.load();
  }
  private stopCurrent(generation: number): void {
    const element = this.activeElement;
    const graph = this.graph;
    const retirePlain = element === this.plainElement && this.currentUrl !== "";
    this.activeCleanup?.();
    this.activeCleanup = undefined;
    this.seekCleanup?.();
    this.seekCleanup = undefined;
    this.pendingSeek = undefined;
    this.graph = undefined;
    this.currentUrl = "";
    this.sourceInfo = undefined;
    this.sourceError = false;
    // Retire the owner before pause/load can synchronously reenter the driver.
    if (retirePlain && !this.disposed) this.plainElement = this.options.createElement();
    this.activeElement = this.plainElement;
    graph?.dispose();
    this.releaseElement(element, generation);
    if (graph && this.generation.isCurrent(generation))
      this.emit("processingchange", new Event("processingchange"));
  }
  private fallbackToPlain(generation: number, element: HTMLAudioElement): void {
    if (!this.matches(generation, element) || !this.graph) return;
    const position =
      this.pendingSeek?.element === element ? this.pendingSeek.position : element.currentTime;
    const url = this.currentUrl;
    const sourceInfo = this.sourceInfo;
    this.stopCurrent(generation);
    if (!this.isCurrent(generation)) return;
    this.activate(this.plainElement, generation);
    if (!this.matches(generation, this.plainElement)) return;
    this.plainElement.crossOrigin = null;
    this.assignSource(this.plainElement, url, generation, sourceInfo);
    if (this.matches(generation, this.plainElement))
      this.restorePosition(this.plainElement, generation, position);
  }
  private restorePosition(element: HTMLAudioElement, generation: number, position: number): void {
    this.seekCleanup?.();
    this.seekCleanup = undefined;
    this.pendingSeek = undefined;
    if (element.readyState === 0) {
      const pending = { element, position };
      this.pendingSeek = pending;
      const restore = () => {
        element.removeEventListener("loadedmetadata", restore);
        if (this.pendingSeek === pending) this.pendingSeek = undefined;
        if (this.matches(generation, element)) element.currentTime = position;
      };
      element.addEventListener("loadedmetadata", restore, { once: true });
      this.seekCleanup = () => element.removeEventListener("loadedmetadata", restore);
    } else if (this.matches(generation, element)) {
      element.currentTime = position;
    }
  }
  private emit(event: AudioDriverEvent, mediaEvent: Event): void {
    const generation = this.loadGeneration;
    const element = this.activeElement;
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      if (
        !this.generation.isCurrent(generation) ||
        element !== this.activeElement ||
        (this.disposed && event !== "processingchange")
      )
        break;
      listener(mediaEvent);
    }
  }
}
