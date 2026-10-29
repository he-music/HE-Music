import { shallowRef } from "vue";
import { expect, it } from "vitest";
import type { ScanEntry } from "./mygo.bindings";
import { createLibrarySongRows, filterLibrarySongs } from "./librarySongRows";

function entry(id: string, title: string): ScanEntry {
  return {
    ref: { grantToken: "grant", fileId: id, version: "v1", relativePath: `${id}.mp3` },
    relativePath: `${id}.mp3`,
    filename: `${id}.mp3`,
    size: 10,
    metadata: {
      Title: title,
      Artists: ["Artist"],
      Album: "Album",
      Container: "MP3",
      AlbumArtists: [],
      Comment: "",
      Lyrics: "",
      Pictures: [],
      PicturesLoaded: false,
      DurationSeconds: 42,
      BitrateKbps: 128,
      SampleRateHz: 44100,
      Channels: 2,
      BitsPerSample: 0,
      Codec: "MPEG",
    },
  };
}
it("filters by title, artist and album while preserving row identity and transient capabilities", () => {
  const first = entry("first", "中文标题");
  const source = shallowRef<readonly ScanEntry[]>([first, entry("second", "Other")]);
  const rows = createLibrarySongRows(source);
  const original = rows.value;
  expect(filterLibrarySongs(original, " 中文 ")).toEqual([original[0]]);
  expect(filterLibrarySongs(original, "ARTIST")).toEqual(original);
  expect(filterLibrarySongs(original, "album")).toEqual(original);
  expect(filterLibrarySongs(original, "  ")).toBe(original);
  expect(filterLibrarySongs(original, "absent")).toEqual([]);
  source.value = [first, entry("third", "New")];
  expect(rows.value[0]).toBe(original[0]);
  expect(source.value[0].ref.grantToken).toBe("grant");
  expect(JSON.stringify(rows.value)).not.toMatch(/grantToken|version|fileId/);
  source.value = [];
  expect(rows.value).toEqual([]);
});
