import { createOAuthFlow } from "./oauthFlow";
import { platform } from "./index";
import {
  createAuthSession,
  getAuthStatus,
  exchangeAuthResult,
  type ExchangeAuthResultResponse,
} from "@/api/auth";
import { getDeviceInfo } from "@/utils/device";

/** 桌面 OAuth 不传 redirect_uri，通过状态轮询领取一次性授权结果。 */
export function createDesktopOAuth(
  accept: (result: ExchangeAuthResultResponse) => Promise<void>,
  onError: () => void,
  onPendingChange?: (pending: boolean) => void,
) {
  return createOAuthFlow({
    async create(provider, signal) {
      const device_info = await getDeviceInfo();
      if (signal.aborted) throw new Error("Authorization cancelled");
      return createAuthSession({ provider, device_info }, signal);
    },
    status: getAuthStatus,
    exchange: exchangeAuthResult,
    open: (url) => platform.openExternal(url),
    accept,
    onError,
    onPendingChange,
  });
}
