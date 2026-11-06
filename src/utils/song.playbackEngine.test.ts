import { describe, expect, it } from "vitest";
import type { SongInfo } from "@/types/main.hemusic";
import { getSongCanDownload, getSongCanPlayLinks } from "./song";

describe("歌曲格式按播放引擎准入", () => {
  it("mpv 接受 DSD/APE，浏览器继续过滤；下载链接不受播放选择影响", () => {
    const song: SongInfo = {
      id: "synthetic",
      name: "Synthetic",
      subtitle: "",
      duration: 0,
      mv_id: "",
      album: "",
      platform: "test",
      cover: "",
      links: ["mp3", "dsf", "dff", "ape"].map((format) => ({
        name: format === "dsf" ? "dsd" : format,
        format,
        quality: 1,
        size: "1",
        url: "",
      })),
    };
    expect(getSongCanPlayLinks(song, "web-audio").map((link) => link.format)).toEqual(["mp3"]);
    expect(getSongCanPlayLinks(song, "mpv").map((link) => link.format)).toEqual([
      "mp3",
      "dsf",
      "dff",
      "ape",
    ]);
    expect(getSongCanDownload(song)).toBe(true);
    expect(song.links).toHaveLength(4);
  });
});
