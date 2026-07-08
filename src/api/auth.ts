// 取消收藏歌单
import { requestHemusic } from "@/utils/request";
import type { DeviceInfo, Device, UserInfo } from "@/types/main.hemusic";

// ==================== QR 登录 ====================

export interface CreateQrLoginSessionParams {
  client_type: string;
  client_name: string;
  scene: string;
  device_info?: DeviceInfo;
}

export interface CreateQrLoginSessionResponse {
  session_id: string;
  qr_content: string;
  result_token: string;
  status: string;
  check_interval: number;
  expires_at: number;
}

export interface GetQrLoginSessionStatusResponse {
  session_id: string;
  status: string;
  check_interval: number;
  expires_at: number;
  client_name: string;
  user_hint: string;
}

export interface ExchangeQrLoginResultParams {
  session_id: string;
  result_token: string;
}

export interface ExchangeQrLoginResultResponse {
  session_id: string;
  status: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export const authProviders = () => {
  return requestHemusic({
    url: "/v1/auth/providers",
    method: "get",
  });
};
export interface CreateAuthSessionParams {
  provider: string;
  redirect_uri: string;
  device_info?: DeviceInfo;
}

export interface CreateAuthSessionResponse {
  url: string;
  state: string;
  check_interval: number;
  expires_at: number;
}

/** 创建 OAuth 授权会话，支持携带设备信息 */
export const createAuthSession = (data: CreateAuthSessionParams) => {
  return requestHemusic({
    url: "/v1/auth/session",
    method: "post",
    data,
  }) as Promise<CreateAuthSessionResponse>;
};

export const createQrLoginSession = (data: CreateQrLoginSessionParams) => {
  return requestHemusic({
    url: "/v1/auth/qr/session",
    method: "post",
    data,
  }) as Promise<CreateQrLoginSessionResponse>;
};

export const getQrLoginSessionStatus = (session_id: string) => {
  return requestHemusic({
    url: "/v1/auth/qr/status",
    method: "get",
    params: { session_id },
  }) as Promise<GetQrLoginSessionStatusResponse>;
};

export const exchangeQrLoginResult = (data: ExchangeQrLoginResultParams) => {
  return requestHemusic({
    url: "/v1/auth/qr/result",
    method: "post",
    data,
  }) as Promise<ExchangeQrLoginResultResponse>;
};

// ==================== Token 刷新 ====================

export interface RefreshTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/** 刷新 Token，可选携带设备信息更新版本 */
export const refreshTokenApi = (refresh_token: string, device_info?: DeviceInfo) => {
  return requestHemusic({
    url: "/v1/auth/token/refresh",
    method: "post",
    data: { refresh_token, device_info },
  }) as Promise<RefreshTokenResponse>;
};

/** 登出当前设备 */
export const logoutApi = () => {
  return requestHemusic({
    url: "/v1/auth/logout",
    method: "post",
  });
};

// ==================== OAuth 授权结果 ====================

export interface ExchangeAuthResultResponse {
  user?: UserInfo;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/** 用 state 兑换 OAuth 授权结果 */
export const exchangeAuthResult = (state: string) => {
  return requestHemusic({
    url: "/v1/auth/result",
    method: "get",
    params: { state },
  }) as Promise<ExchangeAuthResultResponse>;
};

// ==================== 设备管理 ====================

export interface GetUserDevicesResponse {
  devices: Device[];
  current_device_id: string;
}

export const getUserDevices = () => {
  return requestHemusic({
    url: "/v1/auth/devices",
    method: "get",
  }) as Promise<GetUserDevicesResponse>;
};

export const deleteDevice = (device_id: string) => {
  return requestHemusic({
    url: `/v1/auth/devices/${device_id}`,
    method: "delete",
  });
};

export const batchDeleteDevices = () => {
  return requestHemusic({
    url: "/v1/auth/devices/batch",
    method: "delete",
  }) as Promise<{ deleted_count: number }>;
};
