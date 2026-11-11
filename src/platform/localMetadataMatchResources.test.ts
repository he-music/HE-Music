import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeatureSupportFlag } from "@/api/platform";
import { romaSeparator, transSeparator } from "@/utils/lyric";
import { createMetadataMatchResourceLoader } from "./localMetadataMatchResources";

const mocks = vi.hoisted(() => ({ request: vi.fn(), artwork: vi.fn() }));
vi.mock("@/utils/request", () => ({
  API_URL: "http://localhost:9090/api",
  requestHemusic: mocks.request,
}));
vi.mock("./systemMediaArtwork", () => ({ loadSystemMediaArtwork: mocks.artwork }));
const settings = { downloadLyric: true, downloadLyricTran: true, downloadLyricRoma: true };
const signal = () => new AbortController().signal;
const option = {
  id: "song:alpha",
  platform: "a",
  title: "chosen",
  artists: ["one / two"],
  album: "album",
  cover: "",
};
let flags = 0n;
const context = {
  platform: () => ({ feature_support_flag: flags, image_sizes: [300, 1024, 4096] }),
  token: () => "fixture-token",
};
const loader = () => createMetadataMatchResourceLoader(() => settings, context);

beforeEach(() => {
  vi.resetAllMocks();
  flags = FeatureSupportFlag.GetSongDetail | FeatureSupportFlag.GetSongLyric;
  vi.stubGlobal("window", { __HE_MUSIC_GATEWAY_ORIGIN__: "http://127.0.0.1:4444/session" });
  mocks.request.mockImplementation(async (config: { url: string }) => {
    if (config.url === "/v1/song/lyric")
      return { lyric: "original", trans: "translated", roma: "romanized" };
    throw new Error(`Unexpected route ${config.url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

it("only loads lyrics and artwork without fetching or returning song metadata", async () => {
  mocks.request.mockResolvedValueOnce({
    lyric: "[00:01.000]<0,500>原文",
    trans: "[00:01.000]<0,500>翻译",
    roma: "[00:01.000]<00:01.000>roma",
  });
  mocks.artwork.mockResolvedValue(btoa("\x89PNGfixture"));
  const abort = signal();
  const resources = await loader()({ ...option, cover: "https://covers.test/{x}/{y}.png" }, abort);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({
    url: "/v1/song/lyric",
    params: { id: option.id, platform: option.platform },
    signal: abort,
    skipErrorMessage: true,
  });
  expect(Object.keys(resources).sort()).toEqual(["lyrics", "picture"]);
  expect(resources.lyrics).toBe(
    `[00:01.000]原文\n\n${transSeparator}\n[00:01.000]翻译\n\n${romaSeparator}\n[00:01.000]roma`,
  );
  expect(mocks.artwork).toHaveBeenCalledExactlyOnceWith(
    "http://127.0.0.1:4444/session/__proxy/https://covers.test/1024/1024.png",
    abort,
  );
  expect(resources.picture?.MIME).toBe("image/png");
});

it("retains original lyrics when the download switch disables translation and romanization", async () => {
  const resources = await createMetadataMatchResourceLoader(
    () => ({ ...settings, downloadLyric: false }),
    context,
  )(option, signal());
  expect(resources.lyrics).toBe("original");
});

it("leaves unavailable resources absent without requesting metadata", async () => {
  flags = 0n;
  expect(await loader()(option, signal())).toEqual({ picture: undefined });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.artwork).not.toHaveBeenCalled();
  flags = FeatureSupportFlag.GetSongLyric;
  mocks.request.mockResolvedValueOnce({ lyric: "", trans: "", roma: "" });
  expect((await loader()(option, signal())).lyrics).toBeUndefined();
});

it("propagates lyric failure without returning partial resources", async () => {
  mocks.request.mockRejectedValueOnce(new Error("offline"));
  await expect(loader()(option, signal())).rejects.toThrow("offline");
  expect(mocks.artwork).not.toHaveBeenCalled();
});

it("rejects aborted replies before acquiring artwork", async () => {
  const controller = new AbortController();
  mocks.request.mockImplementationOnce(async () => {
    controller.abort();
    return { lyric: "late lyric" };
  });
  await expect(loader()(option, controller.signal)).rejects.toThrow("cancelled");
  expect(mocks.artwork).not.toHaveBeenCalled();
});

it.each(["file:///private/cover.png", "http://127.0.0.1:8888/private"])(
  "rejects uncontrolled cover %s",
  async (cover) => {
    flags = 0n;
    await expect(loader()({ ...option, cover }, signal())).rejects.toThrow();
    expect(mocks.artwork).not.toHaveBeenCalled();
  },
);
