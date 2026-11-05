export interface ApplicationLogProvider {
  write(level: string, message: string): Promise<void>;
}

/** 保存有界的文本与错误摘要；完整对象、响应内容和堆栈仅保留在控制台。 */
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
  const description = (values: unknown[]): string => {
    const parts: string[] = [];
    for (const value of values.slice(0, 8)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        parts.push(String(value));
      } else if (value instanceof Error) {
        const summary = `${value.name}: ${value.message}`;
        if (!parts.some((part) => part.includes(summary))) parts.push(summary);
        if ("code" in value && (typeof value.code === "string" || typeof value.code === "number")) {
          parts.push(`code=${value.code}`);
        }
        if (
          "response" in value &&
          typeof value.response === "object" &&
          value.response !== null &&
          "status" in value.response &&
          typeof value.response.status === "number"
        ) {
          parts.push(`status=${value.response.status}`);
        }
      }
    }
    return parts.join(" ") || "Console diagnostic";
  };
  const warn: Console["warn"] = (...values: unknown[]) => {
    originalWarn.apply(output, values);
    send("warn", description(values));
  };
  const error: Console["error"] = (...values: unknown[]) => {
    originalError.apply(output, values);
    send("error", description(values));
  };
  output.warn = warn;
  output.error = error;
  const onError = (event: Event) =>
    send(
      "error",
      description([
        "Unhandled page error",
        ("error" in event ? event.error : undefined) ||
          ("message" in event ? event.message : undefined),
      ]),
    );
  const onRejection = (event: Event) =>
    send(
      "error",
      description(["Unhandled promise rejection", "reason" in event ? event.reason : undefined]),
    );
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
