export interface ApplicationLogProvider {
  write(level: string, message: string): Promise<void>;
}

/** Persist diagnostic categories only. Keep objects, response bodies and stacks
 * in the original console, rather than serializing account/application state. */
export function installApplicationLogging(
  provider: ApplicationLogProvider,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  output: Pick<Console, "warn" | "error"> = console,
): () => void {
  const originalWarn = output.warn;
  const originalError = output.error;
  let active = true;
  let reportedFailure = false;
  const send = (level: "warn" | "error", message: string) => {
    if (!active) return;
    try {
      void provider.write(level, message.slice(0, 1024)).catch(() => {
        if (!active || reportedFailure) return;
        reportedFailure = true;
        originalWarn.call(output, "应用日志写入失败");
      });
    } catch {
      if (!reportedFailure) {
        reportedFailure = true;
        originalWarn.call(output, "应用日志不可用");
      }
    }
  };
  const description = (value: unknown) =>
    typeof value === "string" ? value : value instanceof Error ? value.name : "Console diagnostic";
  const warn: Console["warn"] = (...values: unknown[]) => {
    originalWarn.apply(output, values);
    send("warn", description(values[0]));
  };
  const error: Console["error"] = (...values: unknown[]) => {
    originalError.apply(output, values);
    send("error", description(values[0]));
  };
  output.warn = warn;
  output.error = error;
  const onError = () => send("error", "Unhandled page error");
  const onRejection = () => send("error", "Unhandled promise rejection");
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    active = false;
    if (output.warn === warn) output.warn = originalWarn;
    if (output.error === error) output.error = originalError;
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
