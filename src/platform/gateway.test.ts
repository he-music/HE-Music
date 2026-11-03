import { afterEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosHeaders } from "axios";

const gateway = "http://127.0.0.1:49234/session-secret";
async function setup() {
  vi.resetModules();
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gateway });
  const module = await import("./gateway");
  const configure = vi.fn(async () => {});
  await module.initializeGateway({ configure }, "https://api.example/music/", "/api/netease");
  return { ...module, configure };
}

afterEach(() => vi.unstubAllGlobals());

describe("mygo gateway request boundaries", () => {
  it("recognizes only the injected loopback proxy route as an admitted resource", async () => {
    const module = await setup();
    const resource = module.gatewayProxyUrl("https://cdn.example/song.mp3");
    expect(module.isMygoGatewayResourceUrl(resource)).toBe(true);
    for (const other of [
      `${gateway}/__api/hemusic/song?target=anything`,
      `${gateway}/__proxy?target=`,
      resource.replace("session-secret", "another-session"),
      resource.replace("49234", "49235"),
      resource.replace("127.0.0.1", "user:password@127.0.0.1"),
      "https://cdn.example/__proxy?target=anything",
    ]) {
      expect(module.isMygoGatewayResourceUrl(other)).toBe(false);
    }
    vi.stubGlobal("window", {});
    expect(module.isMygoGatewayResourceUrl(resource)).toBe(false);
  });

  it("keeps standalone Web request configuration and source URLs intact", async () => {
    vi.stubGlobal("window", {});
    const module = await import("./gateway");
    const config = { url: "/song", baseURL: "/api/netease", params: { id: 1 } };
    const before = structuredClone(config);
    expect(module.rewriteRequestToGateway(config, config.baseURL, "netease")).toBe(config);
    expect(config).toEqual(before);
    expect(module.gatewayProxyUrl("https://cdn.example/song.mp3")).toBe(
      "https://cdn.example/song.mp3",
    );
    await expect(module.initializeGateway(undefined, "", "")).resolves.toBeUndefined();
  });

  it("configures fixed remote API bases independently of the frontend page origin", async () => {
    const module = await setup();
    expect(module.configure).toHaveBeenCalledExactlyOnceWith({
      hemusic: "https://api.example/music",
      netease: "https://api.example/api/netease",
      unblock: "https://api.example/api/unblock",
    });
    const config = module.rewriteRequestToGateway(
      { url: "/song/detail", baseURL: "/api/netease" },
      "/api/netease",
      "netease",
    );
    expect(config.url).toBe(`${gateway}/__api/netease/song/detail`);
  });

  it("preserves Axios base paths, body, headers, params and a custom serializer", async () => {
    const module = await setup();
    const body = { captcha: "code" };
    const headers = new AxiosHeaders({ Authorization: "Bearer current" });
    const params = { tag: ["一", "二"], q: "a+b" };
    const paramsSerializer = { serialize: () => "tag=one&tag=two&q=a%2Bb" };
    const config = module.rewriteRequestToGateway(
      {
        url: "/v1/auth/login?keep=%2F",
        baseURL: "https://api.example/music/",
        method: "post",
        data: body,
        headers,
        params,
        paramsSerializer,
      },
      "https://api.example/music/",
    );
    expect(axios.getUri(config)).toBe(
      `${gateway}/__api/hemusic/v1/auth/login?keep=%2F&tag=one&tag=two&q=a%2Bb`,
    );
    expect(config.data).toBe(body);
    expect(config.headers).toBe(headers);
    expect(config.params).toBe(params);
    expect(config.paramsSerializer).toBe(paramsSerializer);
    expect(module.gatewayRequestURL(config)).toBe("/v1/auth/login?keep=%2F");
    const retry = module.rewriteRequestToGateway(config, "https://api.example/music/");
    expect(retry).toBe(config);
    expect(axios.getUri(retry)).toBe(axios.getUri(config));
  });

  it("does not send authenticated API requests to unregistered origins or escaped base paths", async () => {
    const module = await setup();
    for (const url of ["https://other.example/v1", "../private", "/../../other"]) {
      expect(() => module.rewriteRequestToGateway({ url }, "https://api.example/music/")).toThrow();
    }
  });

  it("keeps Unicode, signed queries and media fragments while rewriting only once", async () => {
    const module = await setup();
    const source = "https://cdn.example/歌曲.mp3?signature=a%2Bb&part=1&part=2#t=10";
    const local = module.gatewayProxyUrl(source);
    const parsed = new URL(local);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${gateway}/__proxy`);
    const encoded = parsed.searchParams.get("target") ?? "";
    const remote = new TextDecoder().decode(
      Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (value) =>
        value.charCodeAt(0),
      ),
    );
    expect(remote).toBe("https://cdn.example/%E6%AD%8C%E6%9B%B2.mp3?signature=a%2Bb&part=1&part=2");
    expect(parsed.hash).toBe("#t=10");
    expect(module.gatewayProxyUrl(local)).toBe(local);
    expect(source).toContain("歌曲");
  });

  it("preserves local grants, blobs, packaged assets and IPv6 loopback", async () => {
    const module = await setup();
    for (const source of [
      "http://127.2.3.4:80/audio",
      "http://[::1]:80/audio",
      "http://localhost:80/audio",
      "blob:local",
      "data:image/png;base64,AA",
      "/images/song.jpg?asset",
      "mygo://app/images/song.jpg",
    ]) {
      expect(module.gatewayProxyUrl(source)).toBe(source);
    }
    expect(module.gatewayProxyUrl("//cdn.example/image.png")).toContain("/__proxy?target=");
  });

  it("rejects unavailable or invalid mygo setup instead of silently falling back to direct API traffic", async () => {
    const module = await setup();
    await expect(module.initializeGateway(undefined, "https://api.example", "")).rejects.toThrow();
    await expect(
      module.initializeGateway({ configure: vi.fn() }, "file:///tmp/api", ""),
    ).rejects.toThrow();
    await expect(
      module.initializeGateway({ configure: vi.fn() }, "https://user:password@api.example", ""),
    ).rejects.toThrow();
  });
});
