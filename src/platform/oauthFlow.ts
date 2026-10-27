import type { CreateAuthSessionResponse, ExchangeAuthResultResponse } from "@/api/auth";

export interface AuthCallbackEvent {
  sessionId: string;
  state: string;
}

export interface OAuthDependencies {
  subscribe(listener: (event: AuthCallbackEvent) => void): () => void;
  prepare(): Promise<{ sessionId: string; callbackUrl: string }>;
  arm(sessionId: string, state: string, expiresAtUnixMs: number): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  create(provider: string, callbackUrl: string): Promise<CreateAuthSessionResponse>;
  exchange(state: string): Promise<ExchangeAuthResultResponse>;
  open(url: string): Promise<void>;
  accept(result: ExchangeAuthResultResponse): Promise<void>;
  onError(): void;
}

/** 只接受 2000～2100 年的 Unix 绝对秒/毫秒；不猜测相对有效期。 */
export function authExpiryUnixMs(value: number, now = Date.now()): number {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid authorization expiry");
  const minimum = Date.UTC(2000, 0, 1);
  const maximum = Date.UTC(2100, 0, 1);
  const milliseconds = value >= minimum / 1000 && value < maximum / 1000 ? value * 1000 : value;
  if (milliseconds < minimum || milliseconds >= maximum || milliseconds <= now) {
    throw new Error("Invalid authorization expiry");
  }
  return milliseconds;
}

interface Attempt {
  sessionId?: string;
  state?: string;
  armed: boolean;
  expiresAt?: number;
  exchanging: boolean;
  off: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

// 同页 modal 重建也共用队列，防止旧 prepare 的原生替换副作用越过新尝试。
let prepareQueue: Promise<void> = Promise.resolve();

/** 每次尝试拥有自己的监听、原生会话与期限，迟到的 Promise 不拥有后续尝试。 */
export function createOAuthFlow(deps: OAuthDependencies) {
  let current: Attempt | undefined;
  const cancelSession = (sessionId: string) => {
    // Go 已消费或取消的精确 ID 会拒绝；清理失败不能覆盖当前业务错误。
    void deps.cancel(sessionId).catch(() => {});
  };
  const release = (attempt: Attempt) => {
    if (current === attempt) current = undefined;
    attempt.off();
    if (attempt.timer) clearTimeout(attempt.timer);
    if (attempt.sessionId) cancelSession(attempt.sessionId);
  };
  const cancel = () => {
    if (current) release(current);
  };
  const fail = (attempt: Attempt) => {
    if (current !== attempt) return;
    release(attempt);
    deps.onError();
  };
  const expireAfter = (attempt: Attempt, milliseconds: number) => {
    if (attempt.timer) clearTimeout(attempt.timer);
    // setTimeout 的上限是有符号 32 位；远期限分段等待，避免溢出立即超时。
    const deadline = Date.now() + milliseconds;
    const tick = () => {
      if (current !== attempt) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail(attempt);
      else attempt.timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
    };
    tick();
  };
  const start = async (provider: string) => {
    cancel();
    const attempt: Attempt = { exchanging: false, armed: false, off: () => {} };
    current = attempt;
    try {
      attempt.off = deps.subscribe((event) => {
        if (
          current !== attempt ||
          !attempt.state ||
          !attempt.armed ||
          Date.now() >= (attempt.expiresAt ?? 0) ||
          event.sessionId !== attempt.sessionId ||
          event.state !== attempt.state ||
          attempt.exchanging
        )
          return;
        attempt.exchanging = true;
        void (async () => {
          try {
            const result = await deps.exchange(event.state);
            if (current !== attempt) return;
            // 兑换成功即接受：先结束流程，再应用登录；成功导致的 modal 卸载不撤回结果。
            release(attempt);
            try {
              await deps.accept(result);
            } catch {
              deps.onError();
            }
          } catch {
            if (current === attempt) fail(attempt);
          }
        })();
      });
      expireAfter(attempt, 60_000);
      const preparation = prepareQueue.then(async () => {
        if (current !== attempt) return undefined;
        const prepared = await deps.prepare();
        if (current === attempt) return prepared;
        try {
          await deps.cancel(prepared.sessionId);
        } catch {
          /* 精确旧会话已清理。 */
        }
        return undefined;
      });
      prepareQueue = preparation.then(
        () => {},
        () => {},
      );
      const prepared = await preparation;
      if (!prepared || current !== attempt) {
        if (prepared) cancelSession(prepared.sessionId);
        return;
      }
      attempt.sessionId = prepared.sessionId;
      const session = await deps.create(provider, prepared.callbackUrl);
      if (current !== attempt) return;
      const expiry = authExpiryUnixMs(session.expires_at);
      if (!session.state.trim()) throw new Error("Invalid authorization state");
      attempt.state = session.state;
      // 浏览器只能在 arm 成功且当前尝试有效后打开。
      await deps.arm(prepared.sessionId, session.state, expiry);
      if (current !== attempt) return;
      attempt.armed = true;
      attempt.expiresAt = expiry;
      expireAfter(attempt, expiry - Date.now());
      if (current !== attempt) return;
      await deps.open(session.url);
    } catch {
      fail(attempt);
    }
  };
  return { start, cancel };
}
