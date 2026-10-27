import type {
  CreateQrLoginSessionResponse,
  ExchangeQrLoginResultResponse,
  GetQrLoginSessionStatusResponse,
} from "@/api/auth";
import type { LoginResult } from "./login";

export type QrLoginStatus =
  | "idle"
  | "creating"
  | "pending"
  | "scanned"
  | "confirmed"
  | "success"
  | "expired"
  | "cancelled"
  | "failure";

export interface QrLoginView {
  content: string;
  status: QrLoginStatus;
}

interface QrDependencies {
  create(): Promise<CreateQrLoginSessionResponse>;
  status(sessionId: string): Promise<GetQrLoginSessionStatusResponse>;
  exchange(sessionId: string, resultToken: string): Promise<ExchangeQrLoginResultResponse>;
  update(view: QrLoginView): void;
  accept(result: LoginResult): void;
  onError(key: string): void;
}

/** pause、重建和卸载都撤销当前代号；异步返回值只能更新发起它的会话。 */
export function createQrLoginFlow(deps: QrDependencies) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    generation++;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const start = async () => {
    stop();
    const id = generation;
    let content = "";
    let interval = 2000;
    let sessionId = "";
    let resultToken = "";
    const active = () => id === generation;
    const update = (status: QrLoginStatus) => deps.update({ content, status });
    const failure = (key: string) => {
      if (!active()) return;
      stop();
      update("failure");
      deps.onError(key);
    };
    const schedule = () => {
      if (!active()) return;
      timer = setTimeout(() => void poll(), interval);
    };
    const handle = async (result: { status: string; check_interval?: number }) => {
      if (!active()) return;
      if (
        typeof result.check_interval === "number" &&
        Number.isFinite(result.check_interval) &&
        result.check_interval > 0
      ) {
        interval = Math.min(Math.max(result.check_interval, 1) * 1000, 60_000);
      }
      switch (result.status) {
        case "pending":
        case "scanned":
          update(result.status);
          schedule();
          break;
        case "confirmed":
          update("confirmed");
          await exchange();
          break;
        case "expired":
        case "cancelled":
          await start();
          break;
        default:
          failure("modal.qr_login_status_failed");
      }
    };
    const exchange = async () => {
      try {
        const result = await deps.exchange(sessionId, resultToken);
        if (!active()) return;
        if (result.status === "success" && result.access_token) {
          stop();
          update("success");
          deps.accept(result);
        } else if (result.status === "confirmed" || result.status === "success") {
          failure("modal.qr_login_exchange_failed");
        } else {
          await handle(result);
        }
      } catch {
        failure("modal.qr_login_exchange_failed");
      }
    };
    const poll = async () => {
      try {
        const result = await deps.status(sessionId);
        if (!active()) return;
        await handle(result);
      } catch {
        failure("modal.qr_login_status_failed");
      }
    };
    update("creating");
    try {
      const result = await deps.create();
      if (!active()) return;
      sessionId = result.session_id;
      resultToken = result.result_token;
      content = result.qr_content;
      if (!sessionId || !resultToken || !content) throw new Error("Invalid QR session");
      await handle(result);
    } catch {
      failure("modal.qr_login_create_failed");
    }
  };
  return { start, stop };
}
