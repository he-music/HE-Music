import { describe, expect, it, vi } from "vitest";
import { readOutputDevices, type OutputDeviceSource } from "./audioOutputDevices";

const devices = [
  { kind: "audiooutput" as const, deviceId: "speaker", groupId: "", label: "Speaker" },
];
const restrictedDevices = [
  { kind: "audiooutput" as const, deviceId: "default", groupId: "", label: "" },
];

function fixture() {
  const stop = vi.fn();
  const source = {
    enumerateDevices: vi.fn<OutputDeviceSource["enumerateDevices"]>(async () => devices),
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })),
  };
  return { source, stop };
}

describe("output device permission lifecycle", () => {
  it("passive enumeration does not request capture", async () => {
    const { source } = fixture();
    source.enumerateDevices.mockResolvedValueOnce(restrictedDevices);
    expect(await readOutputDevices(source, false, () => true)).toBe(restrictedDevices);
    expect(source.getUserMedia).not.toHaveBeenCalled();
  });

  it("does not request capture when named outputs are already available", async () => {
    const { source } = fixture();
    expect(await readOutputDevices(source, true, () => true)).toBe(devices);
    expect(source.getUserMedia).not.toHaveBeenCalled();
    expect(source.enumerateDevices).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "empty outputs", initial: [] },
    { name: "hidden default", initial: restrictedDevices },
    {
      name: "named default only",
      initial: [
        { kind: "audiooutput" as const, deviceId: "default", groupId: "", label: "Default" },
      ],
    },
    {
      name: "hidden output labels",
      initial: [{ kind: "audiooutput" as const, deviceId: "speaker", groupId: "", label: "" }],
    },
  ])(
    "requests audio for $name and stops every track before re-enumeration",
    async ({ initial }) => {
      const { source, stop } = fixture();
      const stopOther = vi.fn();
      source.enumerateDevices.mockResolvedValueOnce(initial);
      source.getUserMedia.mockResolvedValueOnce({
        getTracks: () => [{ stop }, { stop: stopOther }],
      });
      source.enumerateDevices.mockImplementationOnce(async () => {
        expect(stop).toHaveBeenCalledOnce();
        expect(stopOther).toHaveBeenCalledOnce();
        return devices;
      });
      expect(await readOutputDevices(source, true, () => true)).toBe(devices);
      expect(source.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
      expect(source.enumerateDevices).toHaveBeenCalledTimes(2);
    },
  );

  it("cannot keep capture active when the authorized enumeration fails", async () => {
    const { source, stop } = fixture();
    source.enumerateDevices
      .mockResolvedValueOnce(restrictedDevices)
      .mockRejectedValueOnce(new Error("enumeration failed"));
    await expect(readOutputDevices(source, true, () => true)).rejects.toThrow("enumeration failed");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("requests access on an explicit retry when enumeration itself requires permission", async () => {
    const { source, stop } = fixture();
    source.enumerateDevices.mockRejectedValueOnce(new DOMException("Blocked", "NotAllowedError"));
    expect(await readOutputDevices(source, true, () => true)).toBe(devices);
    expect(source.getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true, video: false });
    expect(stop).toHaveBeenCalledOnce();
    expect(source.enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it("does not request capture when the initial enumeration fails", async () => {
    const { source } = fixture();
    source.enumerateDevices.mockRejectedValueOnce(new Error("enumeration failed"));
    await expect(readOutputDevices(source, true, () => true)).rejects.toThrow("enumeration failed");
    expect(source.getUserMedia).not.toHaveBeenCalled();
  });

  it("stops a late granted stream after the settings page has left", async () => {
    const { source, stop } = fixture();
    source.enumerateDevices.mockResolvedValueOnce(restrictedDevices);
    let active = true;
    let grant: (stream: Awaited<ReturnType<typeof source.getUserMedia>>) => void = () => {};
    source.getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const pending = readOutputDevices(source, true, () => active);
    await vi.waitFor(() => expect(source.getUserMedia).toHaveBeenCalledOnce());
    active = false;
    grant({ getTracks: () => [{ stop }] });
    expect(await pending).toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    expect(source.enumerateDevices).toHaveBeenCalledOnce();
  });

  it("discards enumeration results and never requests capture after leaving the page", async () => {
    const { source } = fixture();
    let active = true;
    let finish: (result: typeof restrictedDevices) => void = () => {};
    source.enumerateDevices.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = readOutputDevices(source, true, () => active);
    active = false;
    finish(restrictedDevices);
    expect(await pending).toBeUndefined();
    expect(source.getUserMedia).not.toHaveBeenCalled();
  });

  it("preserves permission denial and does not enumerate afterwards", async () => {
    const { source } = fixture();
    source.enumerateDevices.mockResolvedValueOnce(restrictedDevices);
    const denied = new DOMException("denied", "NotAllowedError");
    source.getUserMedia.mockRejectedValueOnce(denied);
    await expect(readOutputDevices(source, true, () => true)).rejects.toBe(denied);
    expect(source.enumerateDevices).toHaveBeenCalledOnce();
  });

  it("keeps the available default devices when capture is unsupported", async () => {
    const source: OutputDeviceSource = {
      enumerateDevices: vi.fn(async () => restrictedDevices),
    };
    expect(await readOutputDevices(source, true, () => true)).toBe(restrictedDevices);
    expect(source.enumerateDevices).toHaveBeenCalledOnce();
  });

  it("does not start work for an inactive page", async () => {
    const { source } = fixture();
    expect(await readOutputDevices(source, true, () => false)).toBeUndefined();
    expect(source.getUserMedia).not.toHaveBeenCalled();
    expect(source.enumerateDevices).not.toHaveBeenCalled();
  });
});
