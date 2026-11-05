import { afterEach, describe, expect, it, vi } from "vitest";
import { audioOutputFormat, resolveSongAudioSource } from "./audioSource";
import { isMygoGatewayResourceUrl, gatewayProxyUrl } from "./gateway";

const gateway = "http://127.0.0.1:49234/session-secret";
afterEach(() => vi.unstubAllGlobals());

describe("mygo local audio decryption", () => {
  it.each([
    ["kuwo", "mflac", "flac"],
    ["migu", "wav", "wav"],
    ["soda", "aac", "m4a"],
    ["soda", "flac", "m4a"],
  ])("wraps %s audio without registering a source", (platform, format, output) => {
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gateway });
    const source = {
      url: "https://cdn.example/歌曲?sig=a%2Bb&part=1&part=2",
      key: "key+/=",
      format,
    };
    const result = resolveSongAudioSource(platform, source);
    const local = new URL(result.url);
    expect(local.searchParams.get("url")).toBe(new URL(source.url).href);
    expect(local.searchParams.get("key")).toBe(source.key);
    expect(local.searchParams.get("platform")).toBe(platform);
    expect(result.format).toBe(output);
    expect(local.pathname).toBe("/session-secret/__audio");
    expect(isMygoGatewayResourceUrl(result.url)).toBe(true);
    expect(gatewayProxyUrl(result.url)).toBe(result.url);
    expect(isMygoGatewayResourceUrl(result.url.replace("session-secret", "other"))).toBe(false);
    expect(source.format).toBe(format);
  });

  it("keeps Web and existing decrypted server URLs unchanged", () => {
    const encrypted = { url: "https://cdn.example/audio", key: "key", format: "mflac" };
    vi.stubGlobal("window", {});
    expect(resolveSongAudioSource("kuwo", encrypted)).toBe(encrypted);
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gateway });
    const server = { url: "https://decrypt.example/?url=audio&key=key", format: "flac" };
    expect(resolveSongAudioSource("kuwo", server)).toBe(server);
  });

  it("rejects malformed encrypted URLs and unsupported decryption", () => {
    vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: gateway });
    for (const url of [
      "file:///audio",
      "https://user:pass@cdn.example/audio",
      "https://cdn.example/audio#auth=private",
    ])
      expect(() => resolveSongAudioSource("soda", { url, key: "auth", format: "m4a" })).toThrow();
    expect(() =>
      resolveSongAudioSource("unknown", {
        url: "https://cdn.example/audio",
        key: "key",
        format: "mp3",
      }),
    ).toThrow();
    expect(audioOutputFormat("qq", "flac")).toBe("flac");
    expect(audioOutputFormat("qq", "mflac")).toBe("mflac");
  });
});
