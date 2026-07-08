import { isElectron, isMac, isWin, isLinux } from "./env";
import type { DeviceInfo } from "@/types/main.hemusic";
import packageJson from "@/../package.json";

const DEVICE_ID_KEY = "hemusic_device_id";

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
  return isElectron ? "electron" : "web";
}

/**
 * 获取设备名称，Electron 下通过 IPC 获取真实机型名
 */
async function getDeviceName(): Promise<string> {
  if (!isElectron) {
    // 优先使用 userAgentData 获取浏览器名
    const uaData = (navigator as any).userAgentData;
    if (uaData) {
      const model = await uaData.getHighEntropyValues(["model"]).model;
      if (model) return model;
      const brand = uaData.brands.find(
        (b) => !b.brand.includes("Not") && !b.brand.includes("Chromium"),
      );
      return brand ? `${brand.brand} ${brand.version}` : "Web Browser";
    }
    return "Web Browser";
  }
  try {
    return await window.electron.ipcRenderer.invoke("get-device-name");
  } catch {
    if (isMac) return "Mac";
    if (isWin) return "Windows";
    return "Linux";
  }
}

/**
 * 生成并持久化 device_id，格式: {app_type}_{platform}_{uuid}
 */
export function getDeviceId(): string {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    const uuid = crypto.randomUUID();
    deviceId = `${getAppType()}_${getPlatform()}_${uuid}`;
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
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
