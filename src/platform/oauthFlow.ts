import type {
  CreateAuthSessionResponse,
  ExchangeAuthResultResponse,
  GetAuthStatusResponse,
} from "@/api/auth";

export interface OAuthDependencies {
  create(provider: string, signal: AbortSignal): Promise<CreateAuthSessionResponse>;
  status(state: string, signal: AbortSignal): Promise<GetAuthStatusResponse>;
  exchange(state: string, signal: AbortSignal): Promise<ExchangeAuthResultResponse>;
  open(url: string): Promise<void>;
  accept(result: ExchangeAuthResultResponse): Promise<void>;
  onError(): void;
  onPendingChange?(pending: boolean): void;
}

interface Attempt {
  controller: AbortController;
  expiresAt: number;
  pollTimer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

function pollingInterval(seconds: number, fallback = 2000): number {
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.max(seconds, 1), 60) * 1000
    : fallback;
}

/** 每次授权独立轮询 status；成功后只领取一次结果，取消或替换会废弃迟到响应。 */
export function createOAuthFlow(deps: OAuthDependencies) {
  let current: Attempt | undefined;
  const release = (attempt: Attempt) => {
    if (current === attempt) {
      current = undefined;
      deps.onPendingChange?.(false);
    }
    if (attempt.pollTimer) clearTimeout(attempt.pollTimer);
    if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer);
    attempt.controller.abort();
  };
  const cancel = () => {
    if (current) release(current);
  };
  const fail = (attempt: Attempt) => {
    if (current !== attempt) return;
    release(attempt);
    deps.onError();
  };
  const unavailable = (attempt: Attempt) => {
    if (current !== attempt) return true;
    if (Number.isFinite(attempt.expiresAt) && Date.now() < attempt.expiresAt) return false;
    fail(attempt);
    return true;
  };
  const armExpiry = (attempt: Attempt) => {
    if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer);
    // 远期限分段等待，避免 setTimeout 的有符号 32 位上限导致立即过期。
    const tick = () => {
      if (unavailable(attempt)) return;
      attempt.expiryTimer = setTimeout(
        tick,
        Math.min(attempt.expiresAt - Date.now(), 2_147_483_647),
      );
    };
    tick();
  };
  const start = async (provider: string) => {
    cancel();
    const attempt: Attempt = {
      controller: new AbortController(),
      expiresAt: Date.now() + 60_000,
    };
    current = attempt;
    deps.onPendingChange?.(true);
    armExpiry(attempt);
    const signal = attempt.controller.signal;
    try {
      const session = await deps.create(provider, signal);
      if (unavailable(attempt)) return;
      if (!session.state.trim()) throw new Error("Invalid authorization state");
      attempt.expiresAt = Number(session.expires_at) * 1000;
      if (unavailable(attempt)) return;
      armExpiry(attempt);
      let interval = pollingInterval(session.check_interval);
      const schedule = () => {
        if (!unavailable(attempt)) attempt.pollTimer = setTimeout(() => void poll(), interval);
      };
      const poll = async () => {
        if (unavailable(attempt)) return;
        try {
          const status = await deps.status(session.state, signal);
          if (unavailable(attempt)) return;
          if (status.status !== "pending" && status.status !== "success") {
            fail(attempt);
            return;
          }
          // 服务端状态不能延长创建会话时给出的授权期限。
          attempt.expiresAt = Math.min(attempt.expiresAt, Number(status.expires_at) * 1000);
          if (unavailable(attempt)) return;
          armExpiry(attempt);
          if (status.status === "pending") {
            interval = pollingInterval(status.check_interval, interval);
            schedule();
            return;
          }
          const result = await deps.exchange(session.state, signal);
          if (unavailable(attempt)) return;
          if (!result.access_token) throw new Error("Invalid authorization result");
          // 先完成领取，再应用登录；成功触发 modal 卸载不会撤回已接受的结果。
          release(attempt);
          try {
            await deps.accept(result);
          } catch {
            deps.onError();
          }
        } catch {
          fail(attempt);
        }
      };
      await deps.open(session.url);
      schedule();
    } catch {
      fail(attempt);
    }
  };
  return { start, cancel };
}
