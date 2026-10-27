import { createOAuthFlow, type AuthCallbackEvent } from "./oauthFlow";
import { AuthCallback, events } from "./mygo.bindings";
import { platform } from "./index";
import { createAuthSession, exchangeAuthResult, type ExchangeAuthResultResponse } from "@/api/auth";
import { getDeviceInfo } from "@/utils/device";

/** Electron 保留旧 loopback 地址与事件通道，mygo 使用原生预留/arm 契约。 */
export function createDesktopOAuth(
  accept: (result: ExchangeAuthResultResponse) => Promise<void>,
  onError: () => void,
) {
  let electronState = "";
  const electronSessionId = "electron-loopback";
  return createOAuthFlow({
    subscribe(listener) {
      if (platform.kind === "mygo") return events.desktopAuthCallback.on(listener);
      return window.electron.ipcRenderer.on("login-success", (_, data: { state?: string }) => {
        if (data.state && data.state === electronState) {
          const event: AuthCallbackEvent = { sessionId: electronSessionId, state: data.state };
          listener(event);
        }
      });
    },
    async prepare() {
      if (platform.kind === "mygo") return AuthCallback.prepare(0);
      return {
        sessionId: electronSessionId,
        callbackUrl: `http://127.0.0.1:${Number(import.meta.env["VITE_SERVER_PORT"] || 25666)}/login/success`,
      };
    },
    async arm(sessionId, state, expiry) {
      if (platform.kind === "mygo") await AuthCallback.arm(sessionId, state, expiry);
      else electronState = state;
    },
    async cancel(sessionId) {
      if (platform.kind === "mygo") await AuthCallback.cancel(sessionId);
    },
    async create(provider, redirect_uri) {
      return createAuthSession({ provider, redirect_uri, device_info: await getDeviceInfo() });
    },
    exchange: exchangeAuthResult,
    open: (url) => platform.openExternal(url),
    accept,
    onError,
  });
}
