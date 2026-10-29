import type { AxiosRequestConfig } from "axios";

declare global {
  interface Window {
    readonly __HE_MUSIC_GATEWAY_ORIGIN__?: string;
  }
}

declare module "axios" {
  interface AxiosRequestConfig {
    /** Original application URL, retained when Axios retries a gateway request. */
    gatewayOriginalURL?: string;
  }
}

export interface GatewayAPIConfig {
  hemusic: string;
  netease: string;
  unblock: string;
}
export interface GatewayProvider {
  configure(config: GatewayAPIConfig): Promise<void>;
}

type APIRoute = keyof GatewayAPIConfig;
let apiBases: GatewayAPIConfig | undefined;

/** This capability is injected by mygo, never by the standalone Web build. */
export function mygoGatewayOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.__HE_MUSIC_GATEWAY_ORIGIN__?.replace(/\/+$/, "") ?? "";
}

function upstreamBase(value: string, fallback?: string): string {
  const url = fallback ? new URL(value, fallback) : new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid gateway API base URL");
  }
  return url.href.replace(/\/+$/, "");
}

export function gatewayAPIConfig(hemusic: string, netease: string): GatewayAPIConfig {
  const base = upstreamBase(hemusic);
  return {
    hemusic: base,
    netease: upstreamBase(netease || "/api/netease", `${base}/`),
    unblock: upstreamBase("/api/unblock", `${base}/`),
  };
}

/** Configure fixed API routes before mounting any application consumers. */
export async function initializeGateway(
  provider: GatewayProvider | undefined,
  hemusic: string,
  netease: string,
): Promise<void> {
  if (!mygoGatewayOrigin()) return;
  if (!provider) throw new Error("The mygo network gateway is unavailable");
  const config = gatewayAPIConfig(hemusic, netease);
  await provider.configure(config);
  apiBases = config;
}

function encodeTarget(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function localHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)
  );
}

/** URL rewriting is synchronous; no resource registration or media buffering. */
export function gatewayProxyUrl(value: string): string {
  const gateway = mygoGatewayOrigin();
  if (!gateway || !value || /^(?:blob:|data:|file:|mygo:)/i.test(value)) return value;
  if (value === gateway || value.startsWith(`${gateway}/`)) return value;
  // Relative paths address bundled application assets, not remote resources.
  if (!/^(?:https?:)?\/\//i.test(value)) return value;
  let target: URL;
  try {
    target = new URL(value, "https://resource.invalid");
  } catch {
    return value;
  }
  if (!/^https?:$/.test(target.protocol) || localHost(target.hostname)) return value;
  const fragment = target.hash;
  target.hash = "";
  return `${gateway}/__proxy?target=${encodeTarget(target.href)}${fragment}`;
}

function combineURL(base: string, value: string): URL {
  if (/^https?:\/\//i.test(value)) return new URL(value);
  if (value.startsWith("//")) return new URL(`https:${value}`);
  // Axios joins a leading slash to baseURL instead of discarding the base path.
  return new URL(`${base.replace(/\/+$/, "")}/${value.replace(/^\/+/, "")}`);
}

function requestRoute(config: AxiosRequestConfig, defaultRoute: APIRoute): APIRoute {
  if (config.baseURL === "/api/unblock") return "unblock";
  return defaultRoute;
}

export function gatewayAPIUrl(url: string): string {
  if (!mygoGatewayOrigin()) return url;
  return rewriteRequestToGateway({ url }, undefined).url;
}
export function gatewayRequestURL(config: AxiosRequestConfig | undefined): string | undefined {
  return config?.gatewayOriginalURL ?? config?.url;
}

/** Keep params, serializer, body and AxiosHeaders intact, including on retries. */
export function rewriteRequestToGateway<T extends AxiosRequestConfig>(
  config: T,
  _baseURL: string | undefined,
  defaultRoute: APIRoute = "hemusic",
): T {
  const gateway = mygoGatewayOrigin();
  if (!gateway || !config.url) return config;
  if (config.gatewayOriginalURL && config.url.startsWith(`${gateway}/__api/`)) return config;
  if (!apiBases) throw new Error("The mygo gateway API routes have not been configured");
  const route = requestRoute(config, defaultRoute);
  const registeredBase = apiBases[route];
  const selectedBase =
    config.baseURL && /^https?:\/\//i.test(config.baseURL)
      ? upstreamBase(config.baseURL)
      : registeredBase;
  const target = combineURL(selectedBase, config.url);
  const base = new URL(registeredBase);
  const prefix = base.pathname.replace(/\/+$/, "");
  if (
    target.origin !== base.origin ||
    (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`))
  ) {
    throw new Error("The request does not belong to a configured gateway API");
  }
  const relative = target.pathname.slice(prefix.length).replace(/^\/+/, "");
  config.gatewayOriginalURL = config.url;
  config.url = `${gateway}/__api/${route}/${relative}${target.search}${target.hash}`;
  config.baseURL = undefined;
  return config;
}
