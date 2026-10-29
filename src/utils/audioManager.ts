/**
 * @file AudioManager.ts
 * @description 封装原生 AudioContext 与 HTMLAudioElement 的高级音频管理器
 * @author imsyy
 */

import { isElectron } from "@/utils/env";
import { shallowRef } from "vue";
import { AudioProcessingDriver } from "./audioCapability";

/** Only source admission changes update this ref; playback clocks stay inside consumers. */
export const audioProcessingAvailable = shallowRef(false);

/** 扩充 AudioContext 接口以支持 setSinkId (实验性 API) */
interface IExtendedAudioContext extends AudioContext {
  setSinkId?(deviceId: string): Promise<void>;
}

/**
 * 音频事件类型定义
 */
export type AudioEventType =
  | "play"
  | "playing"
  | "pause"
  | "ended"
  | "timeupdate"
  | "error"
  | "waiting"
  | "canplay"
  | "loadedmetadata"
  | "loadstart"
  | "volumechange"
  | "seeking"
  | "seeked"
  | "processingchange";

/**
 * 音频管理器类
 */
class AudioManager {
  /** 核心上下文 */
  private audioCtx: IExtendedAudioContext | null = null;
  /** 音频元素 */
  private legacyElement: HTMLAudioElement | null = null;
  private driver: AudioProcessingDriver | undefined;
  private desiredGains = Array<number>(10).fill(0);
  private desiredSinkId = "";
  private confirmedSinkId = "";
  private sinkRevision = 0;
  private readonly sinkQueues = new WeakMap<object, Promise<void>>();
  private readonly appliedSinks = new WeakMap<object, string>();
  private get audioElement(): HTMLAudioElement | null {
    return this.driver?.element ?? this.legacyElement;
  }

  /** 音频源节点 */
  private sourceNode: MediaElementAudioSourceNode | null = null;
  /** 增益节点 */
  private gainNode: GainNode | null = null;
  /** 分析节点 */
  private analyserNode: AnalyserNode | null = null;
  /** 均衡器节点数组 */
  private filters: BiquadFilterNode[] = [];

  /** 初始化状态 */
  private isInitialized = false;
  /** 音量 (0-1) */
  private volume: number = 1;
  /** 事件监听器集合 */
  private eventListeners: Map<string, Set<(e: Event) => void>> = new Map();
  /** 渐出暂停定时器 */
  private fadeOutTimer: ReturnType<typeof setTimeout> | null = null;

  /** 清理渐出暂停定时器 */
  private clearFadeOutTimer() {
    if (this.fadeOutTimer) {
      clearTimeout(this.fadeOutTimer);
      this.fadeOutTimer = null;
    }
  }

  /** 均衡器频段 (10段) */
  private readonly eqFrequencies = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  /**
   * 构造函数
   */
  constructor() {
    if (isElectron) {
      this.legacyElement = new Audio();
      this.legacyElement.crossOrigin = "anonymous";
    } else {
      this.driver = new AudioProcessingDriver({
        createElement: () => new Audio(),
        frequencies: this.eqFrequencies,
        volume: this.volume,
        prepareOutput: (element, context) => this.applyOutputDevice(element, context),
      });
      this.driver.on("processingchange", () => this.syncProcessingGraph());
    }
    this.bindInternalEvents();
  }

  private syncProcessingGraph() {
    const driver = this.driver;
    if (!driver) return;
    this.audioCtx = driver.context ?? null;
    this.sourceNode = null;
    this.gainNode = driver.gain ?? null;
    this.analyserNode = driver.analyser ?? null;
    this.filters = [...driver.filters];
    this.filters.forEach((filter, index) => {
      filter.gain.value = this.desiredGains[index];
    });
    audioProcessingAvailable.value = driver.processingAvailable;
    void this.applyOutputDevice(driver.element, driver.context).catch((error: unknown) => {
      console.error("AudioManager: 设置输出设备失败", error);
    });
  }
  /**
   * 初始化 AudioContext 和音频图谱
   * 可以在用户交互时手动调用，或者在播放时自动调用
   */
  public init() {
    if (this.isInitialized) return;

    try {
      if (isElectron) {
        // 使用标准 AudioContext
        this.audioCtx = new AudioContext() as IExtendedAudioContext;
        // 创建节点
        this.sourceNode = this.audioCtx.createMediaElementSource(this.audioElement!);
        this.gainNode = this.audioCtx.createGain();
        this.analyserNode = this.audioCtx.createAnalyser();

        // 配置分析器
        this.analyserNode.fftSize = 512;

        // 创建均衡器滤波器
        this.filters = this.eqFrequencies.map((freq) => {
          const filter = this.audioCtx!.createBiquadFilter();
          filter.type = "peaking";
          filter.frequency.value = freq;
          filter.Q.value = 1;
          filter.gain.value = 0; // 默认平坦
          return filter;
        });

        // 连接图谱: Source -> EQ[0] -> ... -> EQ[9] -> Analyser -> Gain -> Destination
        let currentNode: AudioNode = this.sourceNode;
        for (const filter of this.filters) {
          currentNode.connect(filter);
          currentNode = filter;
        }

        currentNode.connect(this.analyserNode);
        this.analyserNode.connect(this.gainNode);
        this.gainNode.connect(this.audioCtx.destination);
        // 同步音量
        this.gainNode.gain.value = this.volume;
      }

      this.isInitialized = true;
      audioProcessingAvailable.value = Boolean(this.analyserNode);
      this.filters.forEach((filter, index) => {
        filter.gain.value = this.desiredGains[index];
      });
    } catch {
      console.error("AudioManager: 初始化 AudioContext 失败");
    }
  }

  /**
   * 加载并播放音频
   * @param url 音频地址
   * @param options 播放选项 (fadeIn: 是否渐入, fadeDuration: 渐入时长, autoPlay: 是否自动播放)
   */
  public async play(
    url?: string,
    options: { fadeIn?: boolean; fadeDuration?: number; autoPlay?: boolean } = {},
  ) {
    this.clearFadeOutTimer();
    if (this.driver) {
      this.clearFadeOutTimer();
      const driver = this.driver;
      if (url) {
        const loading = driver.load(url);
        const generation = driver.loadGeneration;
        const intent = driver.playIntentGeneration;
        await loading;
        if (!driver.isCurrent(generation) || driver.playIntentGeneration !== intent) return;
      }
      this.syncProcessingGraph();
      if (!(options.autoPlay ?? true)) return;
      if (this.gainNode && this.audioCtx) {
        const now = this.audioCtx.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        if (options.fadeIn) {
          this.gainNode.gain.setValueAtTime(0, now);
          this.gainNode.gain.linearRampToValueAtTime(
            this.volume,
            now + (options.fadeDuration || 1),
          );
        } else {
          this.gainNode.gain.setValueAtTime(this.volume, now);
        }
      }
      try {
        await driver.play();
      } catch (error) {
        console.error("AudioManager: 播放失败");
        throw error;
      }
      return;
    }
    if (!this.isInitialized) this.init();

    // 如果上下文被挂起，则恢复
    if (this.audioCtx?.state === "suspended") {
      await this.audioCtx.resume();
    }

    if (url && this.audioElement) {
      this.audioElement.src = url;
      this.audioElement.load();
    }

    // 自动播放控制
    const shouldPlay = options.autoPlay ?? true;

    // 处理渐入
    if (shouldPlay && options.fadeIn && this.gainNode && this.audioCtx) {
      this.gainNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
      this.gainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);
      this.gainNode.gain.linearRampToValueAtTime(
        this.volume,
        this.audioCtx.currentTime + (options.fadeDuration || 1),
      );
    } else if (this.gainNode && this.audioCtx) {
      this.gainNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
      this.gainNode.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
    }

    if (shouldPlay) {
      try {
        await this.audioElement?.play();
      } catch (error) {
        console.error("AudioManager: 播放失败");
        throw error;
      }
    }
  }

  /**
   * 暂停音频
   * @param options 暂停选项 (fadeOut: 是否渐出, fadeDuration: 渐出时长)
   */
  public pause(options: { fadeOut?: boolean; fadeDuration?: number } = {}) {
    this.clearFadeOutTimer();
    const element = this.audioElement;
    const sourceGeneration = this.driver?.loadGeneration;
    if (this.driver && (!options.fadeOut || element?.paused)) {
      this.driver.pause();
      return;
    }
    this.driver?.cancelPendingPlay();
    if (options.fadeOut && this.gainNode && this.audioCtx) {
      const currentTime = this.audioCtx.currentTime;
      // 从当前值线性降低到 0
      this.gainNode.gain.cancelScheduledValues(currentTime);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, currentTime);
      this.gainNode.gain.linearRampToValueAtTime(0, currentTime + (options.fadeDuration || 1));
      // 等待渐出完成后暂停
      this.fadeOutTimer = setTimeout(
        () => {
          if (this.driver) {
            if (sourceGeneration === this.driver.loadGeneration) this.driver.pause();
          } else {
            element?.pause();
          }
          this.fadeOutTimer = null;
        },
        (options.fadeDuration || 1) * 1000,
      );
    } else {
      if (this.driver) this.driver.pause();
      else this.audioElement?.pause();
    }
  }

  /**
   * 切换播放/暂停状态
   */
  public toggle() {
    if (this.paused) {
      this.play();
    } else {
      this.pause();
    }
  }

  /**
   * 停止播放并将时间重置为 0
   */
  public stop() {
    this.clearFadeOutTimer();
    if (this.audioElement) {
      this.pause();
      this.audioElement.currentTime = 0;
    }
  }
  /** Drop a revoked local source, including bytes already buffered by the element. */
  public clearSource() {
    this.clearFadeOutTimer();
    if (this.driver) {
      this.driver.clearSource();
      this.syncProcessingGraph();
      return;
    }
    this.pause();
    this.audioElement?.removeAttribute("src");
    this.audioElement?.load();
  }

  /**
   * 跳转到指定时间
   * @param time 时间（秒）
   */
  public seek(time: number) {
    if (this.driver) {
      this.driver.seek(time);
      return;
    }
    if (this.audioElement) {
      this.audioElement.currentTime = time;
    }
  }

  /**
   * 设置音量
   * @param value 音量值 (0.0 - 1.0)
   */
  public setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.driver) {
      this.driver.setVolume(this.volume);
      return;
    }
    if (this.gainNode && this.audioCtx) {
      this.gainNode.gain.cancelScheduledValues(this.audioCtx.currentTime);
      this.gainNode.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
    } else if (this.audioElement) {
      this.audioElement.volume = this.volume;
    }
  }

  /**
   * 设置播放速率
   * @param value 速率 (0.5 - 2.0)
   */
  public setRate(value: number) {
    if (this.driver) {
      this.driver.setRate(value);
      return;
    }
    if (this.audioElement) {
      this.audioElement.defaultPlaybackRate = value;
      this.audioElement.playbackRate = value;
    }
  }

  /**
   * 获取当前播放速率
   * @returns 当前速率
   */
  public getRate(): number {
    return this.audioElement?.playbackRate || 1;
  }

  /**
   * 获取当前音量
   * @returns 当前音量值 (0.0 - 1.0)
   */
  public getVolume(): number {
    return this.volume;
  }

  /**
   * 监听音频事件
   * @param event 事件名称
   * @param callback 回调函数
   */
  public on(event: AudioEventType, callback: (e: Event) => void) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
  }

  /**
   * 移除事件监听
   * @param event 事件名称
   * @param callback 回调函数
   */
  public off(event: AudioEventType, callback: (e: Event) => void) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  /**
   * 移除所有事件监听
   */
  public offAll() {
    this.eventListeners.clear();
  }

  /**
   * 绑定内部音频元素事件并转发
   * @param event 事件名称
   */
  private bindInternalEvents() {
    if (!this.audioElement) return;

    const events: AudioEventType[] = [
      "play",
      "playing",
      "pause",
      "ended",
      "timeupdate",
      "error",
      "waiting",
      "canplay",
      "loadedmetadata",
      "loadstart",
      "volumechange",
      "seeking",
      "seeked",
      "processingchange",
    ];
    events.forEach((event) => {
      const forward = (e: Event) => {
        const forwarded =
          event === "error"
            ? new CustomEvent("error", {
                detail: { originalEvent: e, errorCode: this.getErrorCode() },
              })
            : e;
        const driver = this.driver;
        const generation = driver?.loadGeneration;
        const element = this.audioElement;
        for (const callback of [...(this.eventListeners.get(event) ?? [])]) {
          if (driver && (driver.loadGeneration !== generation || driver.element !== element)) break;
          callback(forwarded);
        }
      };
      if (this.driver) this.driver.on(event, forward);
      else this.audioElement?.addEventListener(event, forward);
    });
  }

  /**
   * 获取频谱数据 (用于可视化)
   * @returns Uint8Array 频谱数据
   */
  public getFrequencyData(): Uint8Array {
    if (!this.analyserNode) return new Uint8Array(0);
    const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(dataArray);
    return dataArray;
  }

  /**
   * 设置音频输出设备
   * @param deviceId 设备 ID
   */
  public async setSinkId(deviceId: string) {
    const revision = ++this.sinkRevision;
    this.desiredSinkId = deviceId === "default" ? "" : deviceId;
    try {
      await this.applyOutputDevice(this.audioElement, this.audioCtx);
    } catch (error) {
      if (revision === this.sinkRevision) this.desiredSinkId = this.confirmedSinkId;
      throw error;
    }
  }

  private async applyOutputDevice(
    element: HTMLAudioElement | null,
    context: AudioContext | null | undefined,
  ) {
    // Web Audio owns the physical output when a graph exists; an element sink cannot replace it.
    const target: IExtendedAudioContext | HTMLAudioElement | null = context ?? element;
    if (!target) return;
    const desired = this.desiredSinkId;
    if (typeof target.setSinkId !== "function") {
      if (desired === "") {
        this.confirmedSinkId = "";
        return;
      }
      throw new DOMException(
        "This audio output does not support device selection",
        "NotSupportedError",
      );
    }
    const previous = this.sinkQueues.get(target) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const current =
        this.driver?.context ?? this.driver?.element ?? this.audioCtx ?? this.audioElement;
      if (
        target !== current ||
        desired !== this.desiredSinkId ||
        this.appliedSinks.get(target) === desired
      )
        return;
      // Fresh outputs already follow the system default; WebKit need not
      // implement device selection for ordinary playback to work.
      if (desired === "" && !this.appliedSinks.has(target)) {
        this.confirmedSinkId = "";
        return;
      }
      await target.setSinkId?.(desired);
      this.appliedSinks.set(target, desired);
      const active =
        this.driver?.context ?? this.driver?.element ?? this.audioCtx ?? this.audioElement;
      if (target === active) this.confirmedSinkId = desired;
    });
    // A failed request must not block later requests, but its caller sees failure.
    this.sinkQueues.set(
      target,
      operation.catch(() => undefined),
    );
    await operation;
  }

  /**
   * 设置均衡器增益
   * @param index 频段索引 (0-9)
   * @param value 增益值 (-40 to 40)
   */
  public setFilterGain(index: number, value: number) {
    if (!Number.isInteger(index) || index < 0 || index >= 10 || !Number.isFinite(value)) return;
    value = Math.max(-40, Math.min(40, value));
    this.desiredGains[index] = value;
    if (this.filters[index]) {
      this.filters[index].gain.value = value;
    }
  }

  /**
   * 获取当前均衡器设置
   * @returns 各频段增益值数组
   */
  public getFilterGains(): number[] {
    return [...this.desiredGains];
  }

  /**
   * 获取音频总时长
   * @returns 总时长（秒）
   */
  public get duration() {
    return this.audioElement?.duration || 0;
  }

  /**
   * 获取当前播放时间
   * @returns 当前播放时间（秒）
   */
  public get currentTime() {
    return this.audioElement?.currentTime || 0;
  }

  /**
   * 获取是否暂停状态
   * @returns 是否暂停
   */
  public get paused() {
    return this.audioElement?.paused ?? true;
  }

  /**
   * 获取当前播放地址
   * @returns 当前播放地址
   */
  public get src() {
    return this.driver?.source ?? this.audioElement?.src ?? "";
  }
  /**
   * 获取音频错误码
   * @returns 错误码
   */
  public getErrorCode(): number {
    if (!this.audioElement?.error) return 0;

    // 参考 HTML Audio Element 错误码
    // MEDIA_ERR_ABORTED (1): 用户中止了加载
    // MEDIA_ERR_NETWORK (2): 网络错误或资源过期
    // MEDIA_ERR_DECODE (3): 解码错误
    // MEDIA_ERR_SRC_NOT_SUPPORTED (4): 不支持的格式
    switch (this.audioElement.error.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        return 1;
      case MediaError.MEDIA_ERR_NETWORK:
        return 2; // 网络错误或资源过期
      case MediaError.MEDIA_ERR_DECODE:
        return 3;
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        return 4;
      default:
        return 0;
    }
  }
}

export default new AudioManager();
