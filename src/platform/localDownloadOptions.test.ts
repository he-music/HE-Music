import { describe, expect, it } from "vitest";
import { validDownloadFilename } from "./localDownloadSession";
import {
  createLocalDownloadPlan,
  defaultGrantIndex,
  normalizePortableDirectory,
  normalizePortableFilename,
  sanitizeDownloadSegment,
} from "./localDownloadOptions";

const song = {
  id: "1",
  name: "Title",
  subtitle: "",
  duration: 1,
  mv_id: "",
  album: { id: "album", name: "Album" },
  artists: [{ id: "artist", name: "Artist" }],
  links: [],
  platform: "qq",
  cover: "",
};
const settings = {
  fileNameFormat: "artist-title" as const,
  folderStrategy: "artist-album" as const,
  downloadMeta: true,
  downloadCover: true,
  downloadLyric: true,
  downloadLyricTran: true,
  downloadLyricRoma: true,
  saveMetaFile: true,
};

describe("local download options candidate", () => {
  it("normalizes naming and consumes legacy metadata switches", () => {
    expect(sanitizeDownloadSegment("../Artist. ")).toBe("_Artist");
    expect(validDownloadFilename("x\ud800.mp3")).toBe(false);
    expect(normalizePortableFilename("CON.note", "aiff")).toBe("_CON.note.aiff");
    expect(normalizePortableFilename("CON .note", "mp3")).toBe("_CON .note.mp3");
    expect(normalizePortableFilename("COM1 .note", "mp3")).toBe("_COM1 .note.mp3");
    expect(normalizePortableDirectory(["CON .note", "COM1 .note"])).toBe("_CON .note/_COM1 .note");
    expect(
      new TextEncoder().encode(normalizePortableFilename("😀".repeat(200), "aiff")).length,
    ).toBeLessThanOrEqual(240);
    expect(
      new TextEncoder().encode(normalizePortableDirectory(["CON.note", "😀".repeat(200)])!).length,
    ).toBeLessThanOrEqual(240);
    expect(
      createLocalDownloadPlan(
        { ...song, name: "CON" },
        { ...settings, fileNameFormat: "title", folderStrategy: "none" },
      ).filenameStem,
    ).toBe("CON");
    expect(
      new TextEncoder().encode(
        normalizePortableFilename(
          createLocalDownloadPlan({ ...song, name: "x".repeat(500) }, settings).filenameStem,
          "aiff",
        ),
      ).length,
    ).toBeLessThanOrEqual(240);
    expect(createLocalDownloadPlan(song, settings)).toMatchObject({
      filenameStem: "Artist - Title",
      options: {
        relativeDirectory: "Artist/Album",
        writeMetadata: true,
        writeCover: true,
        writeLyrics: true,
        saveSidecars: true,
      },
    });
  });

  it("selects the saved default grant by display path", () => {
    const grants = [
      { token: "a", epoch: 1, displayPath: "Music" },
      { token: "b", epoch: 1, displayPath: "Downloads" },
    ];
    expect(defaultGrantIndex(grants, "Downloads")).toBe(1);
    expect(defaultGrantIndex(grants, "missing")).toBe(0);
  });

  it("disables dependent writes when metadata is disabled", () => {
    expect(
      createLocalDownloadPlan(song, { ...settings, downloadMeta: false }).options,
    ).toMatchObject({
      writeMetadata: false,
      writeCover: false,
      writeLyrics: false,
      saveSidecars: false,
    });
  });
});
