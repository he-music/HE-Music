import type { PlatformShortcuts } from "./shortcuts";
import type { PlatformSystemMedia } from "./systemMedia";
import type { PlatformFiles } from "./files";
import type { PlatformDesktopLyrics } from "./desktopLyrics";
import type { PlatformUpdates } from "./updates";
import type {
  CloseRequested,
  CloseResolution,
  LifecycleConfig,
  LifecycleStatus,
  TrayRequest,
  TrayPlaybackState,
} from "./mygo.bindings";
export type PlatformKind = "web" | "electron" | "mygo";
export type SystemPlatform = "darwin" | "win32" | "linux" | "unknown";

export interface PlatformCapabilities {
  readonly windowControls: boolean;
  readonly tray: boolean;
  readonly desktopLyrics: boolean;
  readonly localMusic: boolean;
  readonly electronStartup: boolean;
}

export interface PlatformWindow {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
  reload(): Promise<void>;
  onMaximized(listener: (maximized: boolean) => void): () => void;
}

export interface PlatformLifecycle {
  ready(config: LifecycleConfig): Promise<LifecycleStatus>;
  syncConfig(config: LifecycleConfig): Promise<void>;
  syncPlayback(playback: TrayPlaybackState): Promise<void>;
  acknowledgeClose(requestId: number): Promise<void>;
  resolveClose(requestId: number, resolution: CloseResolution): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
  teardown(): Promise<void>;
  onCloseRequested(listener: (request: CloseRequested) => void): () => void;
  onTrayAction(listener: (action: TrayRequest) => void): () => void;
}
export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly os: SystemPlatform;
  readonly capabilities: PlatformCapabilities;
  readonly window: PlatformWindow | null;
  openExternal(url: string, target?: "_self" | "_blank"): Promise<void>;
  readonly lifecycle?: PlatformLifecycle;
  readonly shortcuts?: PlatformShortcuts;
  readonly systemMedia?: PlatformSystemMedia;
  readonly files?: PlatformFiles;
  readonly desktopLyrics?: PlatformDesktopLyrics;
  readonly updates?: PlatformUpdates;
}

export function systemFromUserAgent(userAgent: string): SystemPlatform {
  if (userAgent.includes("Windows")) return "win32";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "darwin";
  if (userAgent.includes("Linux")) return "linux";
  return "unknown";
}

export function externalHttpURL(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("External links must use HTTP or HTTPS");
  }
  return parsed.href;
}
