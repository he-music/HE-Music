import type { PlaybackEngineId } from "@/core/audio-player/IPlaybackEngine";

export interface PlaybackDeviceSelection {
  id: string;
  label: string;
}
export type PlaybackOutputDevices = Record<PlaybackEngineId, PlaybackDeviceSelection>;
export const defaultOutputDevices = (): PlaybackOutputDevices => ({
  "web-audio": { id: "default", label: "" },
  mpv: { id: "default", label: "" },
});

/** 只把旧设备迁移到浏览器，原生设备 ID 使用独立命名空间。 */
export function migratePlaybackSettings(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid playback settings");
  const input = { ...value };
  if (!("playbackEngine" in input)) Object.assign(input, { playbackEngine: "web-audio" });
  if (!("outputDevices" in input)) {
    const devices = defaultOutputDevices();
    if ("playDevice" in input && typeof input.playDevice === "string")
      devices["web-audio"].id = input.playDevice || "default";
    Object.assign(input, { outputDevices: devices });
  }
  return input;
}
