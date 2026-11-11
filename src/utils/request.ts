import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { isDev } from "@/utils/env";
import { useDataStore, useSettingStore } from "@/stores";
import { openCaptcha, openUserLogin } from "@/utils/modal";
import { refreshTokenApi } from "@/api/auth";
import { getDeviceInfo } from "@/utils/device";
import { clientInstanceHeader, getClientInstanceID, isHemusicRequest } from "./clientInstance";

import { gatewayRequestURL, mygoGatewayOrigin, rewriteRequestToGateway } from "@/platform/gateway";
export const API_URL = String(import.meta.env["VITE_API_URL"]);
// 全局地址
const baseURL: string = String(isDev ? "/api/netease" : import.meta.env["VITE_NETEASE_API_URL"]);
const REFRESH_TOKEN_URL = "/v1/auth/token/refresh";
type CaptchaRetryConfig = AxiosRequestConfig & { _captchaRetried?: boolean };

/** 由页面展示可重试错误状态时，避免再弹出重复的通用错误。鉴权处理仍走统一流程。 */
export type HemusicRequestConfig = AxiosRequestConfig & {
  skipErrorMessage?: boolean;
  /** 非幂等操作禁止刷新令牌后重放原请求。 */
  skipAuthRefresh?: boolean;
  _authRetried?: boolean;
};

// Token 刷新并发保护
let isRefreshing = false;
let pendingQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

/** 刷新完成后处理等待队列 */
function processPendingQueue(error: unknown, token?: string) {
  pendingQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve(token!);
  });
  pendingQueue = [];
}

/** 判断是否为跳过自动刷新的接口 */
function isSkipRefreshUrl(url: string | undefined): boolean {
  if (!url) return false;
  return (
    url.includes("/v1/auth/login") ||
    url.includes("/v1/user/login") ||
    url.includes(REFRESH_TOKEN_URL) ||
    url.includes("/v1/auth/logout")
  );
}

/** 判断刷新失败是否由 refresh token 失效导致 */
function isInvalidRefreshTokenError(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    error.response?.status === 401 &&
    (error.response.data as { reason?: string } | undefined)?.reason === "INVALID_REFRESH_TOKEN"
  );
}

// 基础配置
const server: AxiosInstance = axios.create({
  baseURL,
  // 允许跨域
  withCredentials: true,
  // 超时时间
  timeout: 15000,
});

// 基础配置
const serverHemusic: AxiosInstance = axios.create({
  baseURL: API_URL,
  // 浏览器不能安全检查自动跨域重定向；API 重定向直接拒绝，避免实例标识外泄。
  adapter: "fetch",
  fetchOptions: { redirect: "error" },
  // 允许跨域
  withCredentials: true,
  // 超时时间
  timeout: 15000,
});

server.interceptors.request.use((request) => {
  request.headers.delete(clientInstanceHeader);
  return rewriteRequestToGateway(request, baseURL, "netease");
});

// 请求拦截器
serverHemusic.interceptors.request.use(
  (request) => {
    // pinia
    const settingStore = useSettingStore();
    if (!request.params) request.params = {};
    const token = useDataStore().token;
    if (token) request.headers.set("Authorization", "Bearer " + token);
    request.headers.set("Accept-Language", `${settingStore.language};q=0.9`);
    if (isHemusicRequest(request, API_URL)) {
      const instanceID = getClientInstanceID();
      if (instanceID) request.headers.set(clientInstanceHeader, instanceID);
      else request.headers.delete(clientInstanceHeader);
    } else {
      request.headers.delete(clientInstanceHeader);
    }
    // 没有content-type，添加默认值
    if (!request.headers.get("Content-Type")) {
      request.headers.set("Content-Type", "application/json");
    }

    if (settingStore.proxyProtocol !== "off" && !mygoGatewayOrigin()) {
      // proxy
      const protocol = settingStore.proxyProtocol.toLowerCase();
      const server = settingStore.proxyServe;
      const port = settingStore.proxyPort;
      const proxy = `${protocol}://${server}:${port}`;
      if (proxy) request.params.proxy = proxy;
    }
    // 发送请求
    rewriteRequestToGateway(request, API_URL);
    return request;
  },
  (error: AxiosError) => {
    console.error("请求发送失败", error);
    return Promise.reject(error);
  },
);

// 响应拦截器
serverHemusic.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError) => {
    const { response, config } = error;
    // 状态码处理
    switch (response?.status) {
      case 400:
        console.error("客户端错误：", response.status, response.statusText);
        // 执行客户端错误的处理逻辑
        break;
      case 401: {
        const options: HemusicRequestConfig | undefined = config;
        if (options?.skipAuthRefresh) break;
        const dataStore = useDataStore();
        const sentAuthorization = config?.headers.get?.("Authorization");
        if (
          (sentAuthorization && sentAuthorization !== `Bearer ${dataStore.token}`) ||
          (config?.headers.has?.("Authorization") === false && dataStore.token)
        ) {
          return Promise.reject(error);
        }
        const refreshToken = dataStore.refreshToken;
        // 匿名 401 由入口展示登录按钮，不弹全局登录框，也不重放为其他身份。
        if (!dataStore.token && !config?.headers.get?.("Authorization")) {
          return Promise.reject(error);
        }
        // 刷新请求的 401 交给发起刷新流程的外层请求统一处理，避免重复登出
        if (gatewayRequestURL(config)?.includes(REFRESH_TOKEN_URL)) return Promise.reject(error);
        // 有 refreshToken 且不是登录/刷新接口，尝试自动刷新
        if (
          refreshToken &&
          !options?._authRetried &&
          !isSkipRefreshUrl(gatewayRequestURL(config))
        ) {
          if (options) options._authRetried = true;
          const originalToken = dataStore.token;
          if (isRefreshing) {
            // 已有刷新请求在进行中，加入等待队列
            return new Promise((resolve, reject) => {
              pendingQueue.push({ resolve, reject });
            }).then((token) => {
              if (dataStore.token !== token) return Promise.reject(error);
              if (config) {
                config.headers.set("Authorization", "Bearer " + token);
                return serverHemusic.request(config);
              }
              return Promise.reject(error);
            });
          }

          isRefreshing = true;
          try {
            const res = await refreshTokenApi(refreshToken, await getDeviceInfo());
            if (dataStore.token !== originalToken || dataStore.refreshToken !== refreshToken) {
              processPendingQueue(error);
              return Promise.reject(error);
            }
            // 更新 token 信息
            dataStore.token = res.access_token;
            dataStore.refreshToken = res.refresh_token;
            dataStore.expiresAt = res.expires_at;
            // 通知等待队列刷新成功
            processPendingQueue(null, res.access_token);
            // 重试原始请求
            if (config) {
              config.headers.set("Authorization", "Bearer " + res.access_token);
              return serverHemusic.request(config);
            }
          } catch (refreshError) {
            // 刷新失败时拒绝所有等待请求，只有 refresh token 明确失效才强制退出
            processPendingQueue(refreshError);
            if (isInvalidRefreshTokenError(refreshError) && dataStore.token === originalToken) {
              try {
                await dataStore.clearUserData();
              } catch (clearError) {
                console.error("清除登录信息失败", clearError);
              }
              openUserLogin();
            }
            console.error("Token 刷新失败", refreshError);
          } finally {
            isRefreshing = false;
          }
          // 刷新流程已处理，不再往下弹通用错误
          return Promise.reject(error);
        } else {
          // 无 refreshToken 或是登录/刷新接口，直接清除登录状态
          console.error("未授权：", response.status, response.statusText);
          await dataStore.clearUserData();
          openUserLogin();
          return Promise.reject(error);
        }
      }
      case 403: {
        const reason = (response?.data as { reason?: string } | undefined)?.reason;
        const captchaConfig = config as CaptchaRetryConfig | undefined;
        const isLoginRequest = gatewayRequestURL(captchaConfig)?.includes("/v1/user/login");
        if (reason === "CAPTCHA_REQUIRED" && isLoginRequest && !captchaConfig?._captchaRetried) {
          const metadata = response?.data as {
            metadata?: { scene?: string; meta?: string };
          };
          const scene = Number(metadata.metadata?.scene);
          const meta = metadata.metadata?.meta;
          if (Number.isFinite(scene) && meta && captchaConfig) {
            const captchaTicket = await openCaptcha(scene, meta);
            if (captchaTicket) {
              captchaConfig._captchaRetried = true;
              const loginData =
                typeof captchaConfig.data === "string"
                  ? (JSON.parse(captchaConfig.data) as Record<string, unknown>)
                  : { ...(captchaConfig.data as Record<string, unknown>) };
              captchaConfig.data = { ...loginData, captcha_ticket: captchaTicket };
              try {
                return await serverHemusic.request(captchaConfig);
              } catch (retryError) {
                return Promise.reject(retryError);
              }
            }
          }
        }
        break;
      }
      case 404:
        console.error("未找到资源：", response.status, response.statusText);
        // 执行未找到资源的处理逻辑
        break;
      case 500:
        console.error("服务器错误：", response.status, response.statusText);
        // 执行服务器错误的处理逻辑
        break;
      default:
        // 处理其他状态码或错误条件
        console.error("未处理的请求错误", error);
    }

    if (!(config as HemusicRequestConfig | undefined)?.skipErrorMessage) {
      window.$message.error(
        (response && (response.data as { message?: string }).message) || error.message,
      );
    }
    return Promise.reject(error);
  },
);

// 请求
const request = async <T = any>(config: AxiosRequestConfig): Promise<T> => {
  const { data } = await server.request<T>(config);
  return data;
};

/** 已迁移接口显式指定响应类型；默认类型暂时兼容尚未迁移的旧接口。 */
export const requestHemusic = async <T = any>(config: HemusicRequestConfig): Promise<T> => {
  const { data } = await serverHemusic.request<T>(config);
  return data;
};

export default request;
