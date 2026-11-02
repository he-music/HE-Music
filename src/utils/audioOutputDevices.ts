type OutputDevice = Pick<MediaDeviceInfo, "kind" | "deviceId" | "groupId" | "label">;

export interface OutputDeviceSource {
  enumerateDevices(): Promise<readonly OutputDevice[]>;
  getUserMedia?(constraints: MediaStreamConstraints): Promise<{
    getTracks(): readonly { stop(): void }[];
  }>;
}

/** Capture is requested only by an explicit user action; no audio is consumed. */
export async function readOutputDevices(
  source: OutputDeviceSource,
  requestCapture: boolean,
  current: () => boolean,
): Promise<readonly OutputDevice[] | undefined> {
  if (!current()) return;
  if (requestCapture) {
    if (!source.getUserMedia)
      throw new DOMException("Media capture unavailable", "NotSupportedError");
    const stream = await source.getUserMedia({ audio: true, video: false });
    // WebKit remembers the frame's audio permission after capture stops. Stop
    // before enumeration so a slow enumeration cannot keep the microphone open.
    for (const track of stream.getTracks()) track.stop();
  }
  if (!current()) return;
  const devices = await source.enumerateDevices();
  return current() ? devices : undefined;
}
