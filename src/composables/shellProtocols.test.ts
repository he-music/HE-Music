import { describe, expect, it, vi } from "vitest";
vi.mock("@/api/song", () => ({ songInfo: vi.fn() }));
vi.mock("@/stores", () => ({ useSettingStore: vi.fn() }));
vi.mock("@/utils/player", () => ({ usePlayer: vi.fn() }));
import { createProtocolPlaybackHandler } from "./shellProtocols";

const intent = { epoch: 1, sequence: 1, platform: "netease", songId: "123" };

describe("shellProtocols playback", () => {
  it("fetches existing songInfo before adding the song", async () => {
    const song = { id: "123" };
    const songInfo = vi.fn(async () => ({ list: [song] }));
    const addNextSong = vi.fn(async () => {});
    const handle = createProtocolPlaybackHandler({
      owner: () => 1,
      songInfo,
      addNextSong,
      reportFailure: vi.fn(),
    });
    await handle(intent, () => true);
    expect(songInfo).toHaveBeenCalledWith("netease", "123");
    expect(addNextSong).toHaveBeenCalledWith(song, true);
  });
  it.each(["owner", "intent"])("drops fetch results after %s expires", async (cause) => {
    let owner: number | undefined = 1;
    let active = true;
    let resolve: ((result: { list: { id: string }[] }) => void) | undefined;
    const songInfo = vi.fn(
      () =>
        new Promise<{ list: { id: string }[] }>((done) => {
          resolve = done;
        }),
    );
    const addNextSong = vi.fn(async () => {});
    const handle = createProtocolPlaybackHandler({
      owner: () => owner,
      songInfo,
      addNextSong,
      reportFailure: vi.fn(),
    });
    const pending = handle(intent, () => active);
    if (cause === "owner") owner = undefined;
    else active = false;
    resolve?.({ list: [{ id: "123" }] });
    await pending;
    expect(addNextSong).not.toHaveBeenCalled();
    await handle(intent, () => active);
    expect(songInfo).toHaveBeenCalledTimes(1);
  });
  it("reports only a fixed failure signal without sensitive error data", async () => {
    const reportFailure = vi.fn();
    const handle = createProtocolPlaybackHandler({
      owner: () => 1,
      songInfo: async () => {
        throw new Error("private URL");
      },
      addNextSong: vi.fn(async () => {}),
      reportFailure,
    });
    await handle(intent, () => true);
    expect(reportFailure).toHaveBeenCalledWith();
  });
});
