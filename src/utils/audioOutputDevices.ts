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
  requestAccess: boolean,
  current: () => boolean,
): Promise<readonly OutputDevice[] | undefined> {
  if (!current()) return;
  let devices: readonly OutputDevice[];
  try {
    devices = await source.enumerateDevices();
  } catch (error) {
    if (
      !requestAccess ||
      !source.getUserMedia ||
      !(error instanceof DOMException) ||
      error.name !== "NotAllowedError"
    )
      throw error;
    devices = [];
  }
  if (!current()) return;
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  const hasNamedOutput = outputs.some(
    (device) =>
      device.deviceId &&
      device.deviceId !== "default" &&
      device.deviceId !== "communications" &&
      device.label.trim(),
  );
  const hasHiddenOutput = outputs.some(
    (device) =>
      device.deviceId !== "default" &&
      device.deviceId !== "communications" &&
      (!device.deviceId || !device.label.trim()),
  );
  if (!requestAccess || !source.getUserMedia || (hasNamedOutput && !hasHiddenOutput))
    return devices;
  const stream = await source
    .getUserMedia({ audio: true, video: false })
    .catch((error: unknown) => {
      // 远程会话可能只有输出没有麦克风；补全名称失败不应丢弃已枚举的输出。
      if (error instanceof DOMException && error.name === "NotFoundError" && outputs.length > 0)
        return undefined;
      throw error;
    });
  if (!stream) return current() ? devices : undefined;
  // 授权只用于补全设备信息；立即关闭全部轨道，避免后续枚举迟迟不返回时占用麦克风。
  for (const track of stream.getTracks()) track.stop();
  if (!current()) return;
  const authorizedDevices = await source.enumerateDevices();
  return current() ? authorizedDevices : undefined;
}
