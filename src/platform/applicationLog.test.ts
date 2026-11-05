import { expect, it, vi } from "vitest";
import { installApplicationLogging } from "./applicationLog";

it("keeps console output while persisting only bounded diagnostic strings and removes hooks", async () => {
  const target = new EventTarget();
  const originalWarn = vi.fn();
  const originalError = vi.fn();
  const output = { warn: originalWarn, error: originalError };
  const provider = { write: vi.fn(async () => {}) };
  const stop = installApplicationLogging(provider, target, output);
  const account = { token: "SECRET", response: { cookie: "SECRET" } };
  output.error("Request failed", account);
  expect(originalError).toHaveBeenCalledWith("Request failed", account);
  expect(provider.write).toHaveBeenCalledExactlyOnceWith("error", "Request failed");
  output.warn(account);
  expect(provider.write).toHaveBeenLastCalledWith("warn", "Console diagnostic");
  output.error(new Error("Connection closed"));
  expect(provider.write).toHaveBeenLastCalledWith("error", "Error: Connection closed");
  target.dispatchEvent(new Event("unhandledrejection"));
  expect(provider.write).toHaveBeenLastCalledWith("error", "Unhandled promise rejection");
  const count = provider.write.mock.calls.length;
  stop();
  expect(output.error).toBe(originalError);
  expect(output.warn).toBe(originalWarn);
  target.dispatchEvent(new Event("unhandledrejection"));
  output.warn("after teardown");
  expect(provider.write).toHaveBeenCalledTimes(count);
});

it("does not recursively forward a logging failure or let it change application errors", async () => {
  const target = new EventTarget();
  const output = { warn: vi.fn(), error: vi.fn() };
  const provider = {
    write: vi.fn(async () => {
      throw new Error("unavailable");
    }),
  };
  const stop = installApplicationLogging(provider, target, output);
  output.error("first");
  output.error("second");
  await Promise.resolve();
  await Promise.resolve();
  expect(provider.write).toHaveBeenCalledTimes(2);
  stop();
  expect(output.warn).toHaveBeenCalledExactlyOnceWith("应用日志写入失败");
});

it("persists error details and status without serializing request or response objects", async () => {
  const target = new EventTarget();
  const output = { warn: vi.fn(), error: vi.fn() };
  const provider = {
    write: vi.fn<(level: string, message: string) => Promise<void>>(async () => {}),
  };
  const stop = installApplicationLogging(provider, target, output);
  const error = Object.assign(new Error("Request failed"), {
    code: "ERR_BAD_RESPONSE",
    config: { headers: { Authorization: "SECRET" } },
    response: { status: 503, data: { token: "SECRET" } },
  });
  output.error("获取歌曲失败", error);
  expect(provider.write).toHaveBeenLastCalledWith(
    "error",
    "获取歌曲失败 Error: Request failed code=ERR_BAD_RESPONSE status=503",
  );
  output.warn("客户端错误：", 400, "Bad Request");
  expect(provider.write).toHaveBeenLastCalledWith("warn", "客户端错误： 400 Bad Request");
  output.error("Error: Request failed", error);
  expect(provider.write).toHaveBeenLastCalledWith(
    "error",
    "Error: Request failed code=ERR_BAD_RESPONSE status=503",
  );
  output.error("x".repeat(2000), error);
  expect(provider.write.mock.calls.at(-1)?.[1]).toHaveLength(1024);
  stop();
});

it("records unhandled errors and rejections while leaving arbitrary objects out", async () => {
  const target = new EventTarget();
  const output = { warn: vi.fn(), error: vi.fn() };
  const provider = { write: vi.fn(async () => {}) };
  const stop = installApplicationLogging(provider, target, output);
  target.dispatchEvent(Object.assign(new Event("error"), { error: new TypeError("Audio failed") }));
  expect(provider.write).toHaveBeenLastCalledWith(
    "error",
    "Unhandled page error TypeError: Audio failed",
  );
  target.dispatchEvent(
    Object.assign(new Event("unhandledrejection"), { reason: new Error("Session failed") }),
  );
  expect(provider.write).toHaveBeenLastCalledWith(
    "error",
    "Unhandled promise rejection Error: Session failed",
  );
  target.dispatchEvent(
    Object.assign(new Event("unhandledrejection"), { reason: { token: "SECRET" } }),
  );
  expect(provider.write).toHaveBeenLastCalledWith("error", "Unhandled promise rejection");
  stop();
});
