import { afterEach, describe, expect, it, vi } from "vitest";
import { audioOutputFormat, getAudioDecryption, resolveSongAudioSource } from "./audioSource";
import { isMygoGatewayResourceUrl, gatewayProxyUrl } from "./gateway";

const gateway = "http://127.0.0.1:49234/session-secret";
afterEach(() => vi.unstubAllGlobals());

describe("audio decryption metadata", () => {
  it("区分本机解密、远端解密服务和普通音源", () => {
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gateway });
    expect(
      getAudioDecryption(`${gateway}/__audio?audio_params=params&url=https://cdn.example`),
    ).toBe("local");
    const service = "https://decrypt.example/?audio_params=params";
    expect(getAudioDecryption(service)).toBe("server");
    expect(getAudioDecryption(gatewayProxyUrl(service))).toBe("server");
    for (const url of [
      "https://cdn.example/song.flac",
      gatewayProxyUrl("https://cdn.example/song.flac"),
      `${gateway}/__local/audio?path=song.flac`,
      "blob:local-song",
      "",
    ]) {
      expect(getAudioDecryption(url)).toBeNull();
    }
    vi.stubGlobal("window", {});
    expect(getAudioDecryption(service)).toBe("server");
  });
});

describe("prepared local audio", () => {
  it.each(["flac", "wav", "m4a"])("透传 %s 输出格式和执行参数", (format) => {
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gateway });
    const source = {
      url: "https://cdn.example/歌曲?sig=a%2Bb&part=1&part=2",
      audio_params: "prepared_params-123",
      format,
    };
    const result = resolveSongAudioSource(source);
    const local = new URL(result.url);
    expect(local.searchParams.get("url")).toBe(new URL(source.url).href);
    expect(local.searchParams.get("audio_params")).toBe(source.audio_params);
    expect(local.searchParams.has("platform")).toBe(false);
    expect(local.searchParams.has("key")).toBe(false);
    expect(local.searchParams.has("p")).toBe(false);
    expect(result).not.toHaveProperty("audio_params");
    expect(result.format).toBe(format);
    expect(local.pathname).toBe("/session-secret/__audio");
    expect(isMygoGatewayResourceUrl(result.url)).toBe(true);
    expect(gatewayProxyUrl(result.url)).toBe(result.url);
    expect(isMygoGatewayResourceUrl(result.url.replace("session-secret", "other"))).toBe(false);
  });

  it("保留网页和已解密的服务端地址", () => {
    const encrypted = { url: "https://cdn.example/audio", audio_params: "params", format: "flac" };
    vi.stubGlobal("window", {});
    expect(resolveSongAudioSource(encrypted)).toBe(encrypted);
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gateway });
    const server = { url: "https://decrypt.example/?audio_params=params", format: "flac" };
    expect(resolveSongAudioSource(server)).toBe(server);
  });

  it("拒绝旧密钥协议、异常 URL 和执行参数", () => {
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gateway });
    for (const url of [
      "file:///audio",
      "https://user:pass@cdn.example/audio",
      "https://cdn.example/audio#private",
    ]) {
      expect(() =>
        resolveSongAudioSource({ url, audio_params: "params", format: "m4a" }),
      ).toThrow();
    }
    const legacy = { url: "https://cdn.example/audio", key: "raw", format: "wav" };
    expect(() => resolveSongAudioSource(legacy)).toThrow("newer server");
    for (const audio_params of ["params+/=", "p".repeat(16 * 1024 + 1)]) {
      expect(() =>
        resolveSongAudioSource({ url: "https://cdn.example/audio", audio_params, format: "wav" }),
      ).toThrow();
    }
    expect(audioOutputFormat("qq", "flac")).toBe("flac");
    expect(audioOutputFormat("kuwo", "mflac")).toBe("flac");
    expect(audioOutputFormat("soda", "aac")).toBe("m4a");
  });
});
