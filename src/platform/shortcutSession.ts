import { watch } from "vue";
import type { PlatformShortcuts, GlobalShortcutBinding, GlobalShortcutResult } from "./shortcuts";
import type { ShortcutAction } from "./mygo.bindings";
import type { SystemPlatform } from "./types";

export interface ShortcutConfiguration {
  globalOpen: boolean;
  shortcutList: Record<string, { globalShortcut: string; isRegistered?: boolean }>;
}

const sessions = new WeakMap<ShortcutConfiguration, ShortcutSession>();

export function shortcutSession(store: ShortcutConfiguration): ShortcutSession | undefined {
  return sessions.get(store);
}

/** A shell owns one native session; every mutation and teardown shares this queue. */
export class ShortcutSession {
  private generation = 0;
  private executableGeneration: number | null = null;
  private revision = 0;
  private active = false;
  private disposed = false;
  private recordings = new Set<symbol>();
  private queue: Promise<void> = Promise.resolve();
  private stopWatch?: () => void;
  private stopEvents: () => void;
  private results: GlobalShortcutResult[] = [];

  constructor(
    private readonly store: ShortcutConfiguration,
    private readonly provider: PlatformShortcuts,
    execute: (action: ShortcutAction) => void,
    private readonly reportFailure: () => void,
    private readonly os: SystemPlatform = "unknown",
  ) {
    sessions.set(store, this);
    this.stopEvents = provider.onAction((event) => {
      if (!this.disposed && this.active && event.generation === this.executableGeneration) {
        execute(event.action);
      }
    });
  }

  start(): Promise<void> {
    if (this.active || this.disposed) return this.queue;
    this.active = true;
    this.stopWatch = watch(
      () => [
        this.store.globalOpen,
        ...this.provider.actions.map((action) => this.store.shortcutList[action]?.globalShortcut),
      ],
      () => {
        void this.refresh();
      },
      { flush: "sync" },
    );
    return this.refresh();
  }

  beginRecording(): symbol {
    const token = Symbol("shortcut recording");
    this.recordings.add(token);
    void this.refresh();
    return token;
  }

  endRecording(token: symbol): Promise<void> {
    if (!this.recordings.delete(token)) return this.queue;
    return this.refresh();
  }

  private bindings(): GlobalShortcutBinding[] {
    return this.provider.actions.map((action) => ({
      action,
      accelerator: this.store.shortcutList[action]?.globalShortcut ?? "",
    }));
  }

  refresh(): Promise<void> {
    this.executableGeneration = null;
    const revision = ++this.revision;
    if (!this.active || this.disposed) return this.queue;
    this.queue = this.queue
      .then(async () => {
        if (this.disposed || revision !== this.revision) return;
        const recording = this.recordings.size > 0;
        let status = await this.provider.replace(
          this.generation,
          this.store.globalOpen && !recording,
          this.bindings(),
        );
        this.generation = status.generation;
        if (recording && revision === this.revision && !this.disposed) {
          status = await this.provider.suspend(this.generation);
          this.generation = status.generation;
        }
        if (this.disposed || revision !== this.revision) return;
        this.results = status.results;
        for (const action of this.provider.actions) {
          const item = this.store.shortcutList[action];
          if (item)
            item.isRegistered = status.results.some(
              (result) =>
                result.action === action &&
                [
                  "invalid",
                  "duplicate-action",
                  "duplicate-accelerator",
                  "registration-failed",
                ].includes(result.status),
            );
        }
        if (
          status.results.some((result) =>
            [
              "invalid",
              "duplicate-action",
              "duplicate-accelerator",
              "registration-failed",
            ].includes(result.status),
          )
        ) {
          this.reportFailure();
        }
        if (status.enabled && !status.suspended && !recording) {
          this.executableGeneration = status.generation;
        }
      })
      .catch(() => {
        this.reportFailure();
      });
    return this.queue;
  }

  /** Prevent a focused DOM event from also executing a chord owned by native. */
  owns(accelerator: string): boolean {
    return (
      this.executableGeneration !== null &&
      this.results.some(
        (result) =>
          result.status === "registered" &&
          normalizeShortcut(result.normalized, this.os) === normalizeShortcut(accelerator, this.os),
      )
    );
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.queue;
    this.disposed = true;
    this.active = false;
    this.executableGeneration = null;
    this.revision++;
    this.stopWatch?.();
    this.recordings.clear();
    if (sessions.get(this.store) === this) sessions.delete(this.store);
    this.queue = this.queue
      .then(async () => {
        if (this.generation !== 0) await this.provider.teardown(this.generation);
      })
      .catch(() => {
        this.reportFailure();
      })
      .finally(() => this.stopEvents());
    return this.queue;
  }
}

export function normalizeShortcut(accelerator: string, os: SystemPlatform = "unknown"): string {
  const aliases: Record<string, string> = {
    cmdorctrl: os === "darwin" ? "super" : "ctrl",
    commandorcontrol: os === "darwin" ? "super" : "ctrl",
    command: "super",
    cmd: "super",
    meta: "super",
    win: "super",
    control: "ctrl",
    option: "alt",
    esc: "escape",
  };
  const parts = accelerator
    .toLowerCase()
    .split("+")
    .map((token) => {
      const key = token.trim().replace(/^(arrow|key|digit)/, "");
      return aliases[key] ?? key;
    });
  return [...new Set(parts)].sort().join("+");
}
