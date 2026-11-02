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
it.each([
  { codec: "mp3", rate: 44100, depth: 0, bitrate: 320, quality: "HQ" },
  { codec: "mp3", rate: 44100, depth: 0, bitrate: 128, quality: undefined },
  { codec: "flac", rate: 44100, depth: 16, bitrate: 800, quality: "SQ" },
  { codec: "alac", rate: 44100, depth: 24, bitrate: 800, quality: "HIRES" },
  { codec: "pcm", rate: 96000, depth: 24, bitrate: 4608, quality: "HIRES" },
  { codec: "pcm-float", rate: 48000, depth: 32, bitrate: 3072, quality: "MASTER" },
  { codec: "aac", rate: 96000, depth: 24, bitrate: 320, quality: "HQ" },
  { codec: "", rate: 0, depth: 0, bitrate: 0, quality: undefined },
])(
  "derives local quality from audio properties: $codec $depth bit $rate Hz",
  ({ codec, rate, depth, bitrate, quality }) => {
    const file = entry("audio", "Audio");
    file.metadata = {
      ...file.metadata,
      Codec: codec,
      SampleRateHz: rate,
      BitsPerSample: depth,
      BitrateKbps: bitrate,
    };
    const rows = createLibrarySongRows(shallowRef([file]));
    expect(rows.value[0].quality).toBe(quality);
  },
);
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
