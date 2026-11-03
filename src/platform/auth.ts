import { createOAuthFlow } from "./oauthFlow";
import { AuthCallback, events } from "./mygo.bindings";
import { platform } from "./index";
import { createAuthSession, exchangeAuthResult, type ExchangeAuthResultResponse } from "@/api/auth";
import { getDeviceInfo } from "@/utils/device";

/** 桌面 OAuth 使用原生预留端口和有期限的回调会话。 */
export function createDesktopOAuth(
  accept: (result: ExchangeAuthResultResponse) => Promise<void>,
  onError: () => void,
) {
  return createOAuthFlow({
    subscribe: (listener) => events.desktopAuthCallback.on(listener),
    prepare: () => AuthCallback.prepare(0),
    arm: (sessionId, state, expiry) => AuthCallback.arm(sessionId, state, expiry),
    cancel: (sessionId) => AuthCallback.cancel(sessionId),
    async create(provider, redirect_uri) {
      return createAuthSession({ provider, redirect_uri, device_info: await getDeviceInfo() });
    },
    exchange: exchangeAuthResult,
    open: (url) => platform.openExternal(url),
    accept,
    onError,
  });
}
