import { describe, expect, it } from "vitest";
import { localDownloadSnapshot } from "./localDownloadPersistence";

describe("download history compatibility", () => {
  it("accepts history written before options existed", () => {
    expect(
      localDownloadSnapshot({
        id: "old",
        label: "Song",
        filename: "song.mp3",
        quality: "320",
        targetDirectory: "/Music",
        phase: "failed",
        done: true,
        committed: false,
        received: 0,
        total: 0,
      }),
    ).not.toHaveProperty("options");
  });

  it("persists safe task presentation and timestamps while dropping runtime capabilities", () => {
    const snapshot = localDownloadSnapshot({
      id: "task",
      label: "Title",
      filename: "song.mp3",
      quality: "320mp3",
      targetDirectory: "/Music",
      phase: "success",
      done: true,
      committed: true,
      received: 1,
      total: 1,
      createdAt: 1000,
      completedAt: 2000,
      display: {
        artists: "Artist",
        album: "Album",
        duration: 180,
        cover: "https://cdn.test/private",
        grantToken: "secret",
      },
      ref: { grantToken: "secret", fileId: "private-file" },
      url: "https://download.test/signed",
    });
    expect(snapshot.display).toEqual({ artists: "Artist", album: "Album", duration: 180 });
    expect(snapshot.createdAt).toBe(1000);
    expect(snapshot.completedAt).toBe(2000);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|https:|private-file/);
    for (const extra of [
      { createdAt: -1 },
      { completedAt: Infinity },
      { display: { artists: "Artist", album: "Album", duration: NaN } },
    ])
      expect(() => localDownloadSnapshot({ ...snapshot, ...extra })).toThrow();
  });

  it("strips runtime cover URL while retaining safe captured metadata", () => {
    const snapshot = localDownloadSnapshot({
      id: "safe",
      label: "Song",
      filename: "song.mp3",
      quality: "320",
      targetDirectory: "/Music",
      phase: "failed",
      done: true,
      committed: false,
      received: 0,
      total: 0,
      options: {
        writeMetadata: true,
        writeCover: true,
        writeLyrics: true,
        saveSidecars: false,
        metadata: {
          title: "Song",
          artists: ["Artist"],
          album: "Album",
          lyrics: "Lyrics",
          coverURL: "https://cdn.test/x",
        },
      },
    });
    expect(snapshot.options?.metadata).toEqual({
      title: "Song",
      artists: ["Artist"],
      album: "Album",
      lyrics: "Lyrics",
    });
  });
});

it("persists a committed warning and grant-relative residual name without credentials", () => {
  const snapshot = localDownloadSnapshot({
    id: "warning",
    label: "Song",
    filename: "song.mp3",
    quality: "320",
    targetDirectory: "/Music",
    phase: "saved",
    done: true,
    committed: true,
    received: 1,
    total: 1,
    warning: "cleanup_failed",
    residualName: "Artist/Album/.hemusic-download-left",
  });
  expect(snapshot).toMatchObject({
    warning: "cleanup_failed",
    residualName: "Artist/Album/.hemusic-download-left",
  });
  expect(JSON.stringify(snapshot)).not.toMatch(/https?:|token|epoch/);
});

it("rejects Windows absolute residual names", () => {
  expect(() =>
    localDownloadSnapshot({
      id: "bad-residual",
      label: "Song",
      filename: "song.mp3",
      quality: "320",
      targetDirectory: "/Music",
      phase: "saved",
      done: true,
      committed: true,
      received: 1,
      total: 1,
      warning: "cleanup_failed",
      residualName: "C:/Users/private/file",
    }),
  ).toThrow("下载历史数据损坏");
});
