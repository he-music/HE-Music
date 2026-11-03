import { applicationStorage } from "@/platform/applicationStorage";
import { isMac, isWin, isLinux } from "./env";
import type { DeviceInfo } from "@/types/main.hemusic";
import packageJson from "@/../package.json";

const DEVICE_ID_KEY = "hemusic_device_id";

function createUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 获取当前平台标识
 */
function getPlatform(): string {
  if (isMac) return "macos";
  if (isWin) return "windows";
  if (isLinux) return "linux";
  return "unknown";
}

/**
 * 获取应用类型
 */
function getAppType(): string {
  // 后端兼容字段：尚未确认服务端接受 mygo 枚举，宿主身份以 platform.kind 为准。
  return "web";
}

/**
 * 获取设备名称，mygo 优先读取原生机型，Web 使用浏览器信息。
 */
async function getDeviceName(): Promise<string> {
  const { platform } = await import("@/platform");
  if (platform.kind === "mygo") {
    try {
      const model = await platform.deviceName?.();
      if (model) return model;
    } catch {
      // Authentication remains available when the native model label cannot be read.
    }
    return isMac ? "Mac" : isWin ? "Windows PC" : isLinux ? "Linux PC" : "Desktop";
  }
  // 优先使用 userAgentData 获取浏览器名。
  const uaData = navigator.userAgentData;
  if (uaData) {
    const { model } = await uaData.getHighEntropyValues(["model"]);
    if (model) return model;
    const brand = uaData.brands.find(
      (item) => !item.brand.includes("Not") && !item.brand.includes("Chromium"),
    );
    return brand ? `${brand.brand} ${brand.version}` : "Web Browser";
  }
  return "Web Browser";
}

/**
 * 生成并持久化 device_id，格式: {app_type}_{platform}_{uuid}
 */
export function getDeviceId(): string {
  let deviceId = applicationStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    const uuid = createUuid();
    deviceId = `${getAppType()}_${getPlatform()}_${uuid}`;
    applicationStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

/**
 * 获取设备信息，用于登录和刷新请求
 */
export async function getDeviceInfo(): Promise<DeviceInfo> {
  return {
    device_id: getDeviceId(),
    platform: getPlatform(),
    app_type: getAppType(),
    app_version: packageJson.version,
    device_name: await getDeviceName(),
  };
}
