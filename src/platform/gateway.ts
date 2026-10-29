import type { AxiosRequestConfig } from "axios";

const GATEWAY_ORIGIN_KEY = "__HE_MUSIC_GATEWAY_ORIGIN__";

type GatewayWindow = Window & { [GATEWAY_ORIGIN_KEY]?: string };

export function mygoGatewayOrigin(): string {
  if (typeof window === "undefined") return "";
  return (window as GatewayWindow)[GATEWAY_ORIGIN_KEY] ?? "";
}

function encodeTarget(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")
  );
}

export function gatewayProxyUrl(url: string): string {
  const origin = mygoGatewayOrigin();
  if (!origin || !/^https?:\/\//i.test(url)) return url;
  try {
    const target = new URL(url);
    if (isLoopbackHost(target.hostname) || target.origin === origin) return url;
  } catch {
    return url;
  }
  return `${origin}/__proxy?target=${encodeTarget(url)}`;
}

function appendParams(url: string, params: AxiosRequestConfig["params"]): string {
  if (!params) return url;
  const target = new URL(url);
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params) target.searchParams.append(key, value);
  } else if (typeof params === "object") {
    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue;
      if (Array.isArray(value))
        value.forEach((item) => target.searchParams.append(key, String(item)));
      else if (value instanceof Date) target.searchParams.set(key, value.toISOString());
      else if (typeof value === "object") target.searchParams.set(key, JSON.stringify(value));
      else target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

export function rewriteRequestToGateway(
  config: AxiosRequestConfig,
  baseURL: string | undefined,
): AxiosRequestConfig {
  const origin = mygoGatewayOrigin();
  if (!origin || !config.url) return config;
  const fallback = typeof location === "undefined" ? "http://127.0.0.1/" : location.origin;
  const configuredBase = config.baseURL ?? baseURL ?? fallback;
  const resolvedBase = /^[a-z][a-z\d+.-]*:/i.test(configuredBase)
    ? configuredBase
    : new URL(configuredBase, fallback).toString();
  const target = new URL(config.url, resolvedBase).toString();
  const targetWithParams = appendParams(target, config.params);
  config.baseURL = origin;
  config.url = "/__proxy";
  config.params = { target: encodeTarget(targetWithParams) };
  config.paramsSerializer = undefined;
  return config;
}
