import { describe, expect, it, vi } from "vitest";
import { readOutputDevices, type OutputDeviceSource } from "./audioOutputDevices";

const devices = [
  { kind: "audiooutput" as const, deviceId: "speaker", groupId: "", label: "Speaker" },
];

function fixture() {
  const stop = vi.fn();
  const source = {
    enumerateDevices: vi.fn(async () => devices),
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })),
  };
  return { source, stop };
}

describe("output device permission lifecycle", () => {
  it("passive enumeration does not request capture", async () => {
    const { source } = fixture();
    expect(await readOutputDevices(source, false, () => true)).toBe(devices);
    expect(source.getUserMedia).not.toHaveBeenCalled();
  });

  it("requests audio only and stops every track before enumeration", async () => {
    const { source, stop } = fixture();
    const stopOther = vi.fn();
    source.getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop }, { stop: stopOther }] });
    source.enumerateDevices.mockImplementationOnce(async () => {
      expect(stop).toHaveBeenCalledOnce();
      expect(stopOther).toHaveBeenCalledOnce();
      return devices;
    });
    expect(await readOutputDevices(source, true, () => true)).toBe(devices);
    expect(source.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
  });

  it("cannot keep capture active when enumeration fails", async () => {
    const { source, stop } = fixture();
    source.enumerateDevices.mockRejectedValueOnce(new Error("enumeration failed"));
    await expect(readOutputDevices(source, true, () => true)).rejects.toThrow("enumeration failed");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops a late granted stream after the settings page has left", async () => {
    const { source, stop } = fixture();
    let active = true;
    let grant: (stream: Awaited<ReturnType<typeof source.getUserMedia>>) => void = () => {};
    source.getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const pending = readOutputDevices(source, true, () => active);
    active = false;
    grant({ getTracks: () => [{ stop }] });
    expect(await pending).toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    expect(source.enumerateDevices).not.toHaveBeenCalled();
  });

  it("discards enumeration results after leaving the page", async () => {
    const { source } = fixture();
    let active = true;
    let finish: (result: typeof devices) => void = () => {};
    source.enumerateDevices.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = readOutputDevices(source, false, () => active);
    active = false;
    finish(devices);
    expect(await pending).toBeUndefined();
  });

  it("preserves permission denial and does not enumerate afterwards", async () => {
    const { source } = fixture();
    const denied = new DOMException("denied", "NotAllowedError");
    source.getUserMedia.mockRejectedValueOnce(denied);
    await expect(readOutputDevices(source, true, () => true)).rejects.toBe(denied);
    expect(source.enumerateDevices).not.toHaveBeenCalled();
  });

  it("fails explicitly when capture is unavailable", async () => {
    const source: OutputDeviceSource = { enumerateDevices: vi.fn(async () => devices) };
    await expect(readOutputDevices(source, true, () => true)).rejects.toMatchObject({
      name: "NotSupportedError",
    });
    expect(source.enumerateDevices).not.toHaveBeenCalled();
  });

  it("does not start work for an inactive page", async () => {
    const { source } = fixture();
    expect(await readOutputDevices(source, true, () => false)).toBeUndefined();
    expect(source.getUserMedia).not.toHaveBeenCalled();
    expect(source.enumerateDevices).not.toHaveBeenCalled();
  });
});
