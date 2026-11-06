import { describe, expect, it } from "vitest";
import { defaultOutputDevices, migratePlaybackSettings } from "./playbackSettings";

describe("playbackSettings", () => {
  it("旧输出设备只迁移到浏览器，mpv 保留独立默认设备", () => {
    expect(migratePlaybackSettings({ playDevice: "old-speaker" })).toEqual({
      playDevice: "old-speaker",
      playbackEngine: "web-audio",
      outputDevices: {
        "web-audio": { id: "old-speaker", label: "" },
        mpv: { id: "default", label: "" },
      },
    });
  });
  it("新设置与不可用设备名称原样保留，不覆盖为默认设备", () => {
    const settings = {
      playbackEngine: "mpv",
      outputDevices: {
        ...defaultOutputDevices(),
        mpv: { id: "coreaudio/headphones", label: "Headphones" },
      },
    };
    expect(migratePlaybackSettings(settings)).toEqual(settings);
    const first = defaultOutputDevices();
    first.mpv.id = "changed";
    expect(defaultOutputDevices().mpv.id).toBe("default");
  });
});
