import { applicationStorage } from "@/platform/applicationStorage";
import type { AxiosRequestConfig } from "axios";

const storageKey = "he-client-instance-id";
export const clientInstanceHeader = "X-Client-Instance-ID";
let instanceID: string | undefined;

export function validClientInstanceID(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value);
}

/** 存储不可用时沿用本次运行的随机标识，不阻断请求。 */
export function getClientInstanceID(): string | undefined {
  if (instanceID) return instanceID;
  try {
    const stored = applicationStorage.getItem(storageKey);
    if (validClientInstanceID(stored)) instanceID = stored;
  } catch {
    // 浏览器隐私设置或原生持久化异常时使用内存标识。
  }
  if (!instanceID) {
    try {
      instanceID = crypto.randomUUID();
    } catch {
      return undefined;
    }
    try {
      applicationStorage.setItem(storageKey, instanceID);
    } catch {
      // 本次运行继续使用同一标识。
    }
  }
  return instanceID;
}

/** 使用改写前的地址判断后端边界；不向其他服务或媒体发送实例标识。 */
export function isHemusicRequest(config: AxiosRequestConfig, apiURL: string): boolean {
  try {
    const origin = typeof location === "undefined" ? undefined : location.href;
    const base = new URL(apiURL, origin);
    const selectedBase = new URL(config.baseURL || apiURL, origin);
    const value = config.gatewayOriginalURL ?? config.url ?? "";
    const target = new URL(
      /^(?:https?:)?\/\//i.test(value)
        ? value
        : `${selectedBase.href.replace(/\/+$/, "")}/${value.replace(/^\/+/, "")}`,
      base,
    );
    const prefix = base.pathname.replace(/\/+$/, "");
    return (
      target.origin === base.origin &&
      !target.username &&
      !target.password &&
      (!prefix || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))
    );
  } catch {
    return false;
  }
}
