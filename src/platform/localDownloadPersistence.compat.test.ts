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
