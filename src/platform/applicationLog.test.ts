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
  output.error(new Error("SECRET"));
  expect(provider.write).toHaveBeenLastCalledWith("error", "Error");
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
