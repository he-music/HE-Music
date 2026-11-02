import { expect, it } from "vitest";
import { parseApplicationBackup } from "./applicationBackup";
import { encodeApplicationValue } from "./applicationStorage";

it("imports an Electron helper export with accounts, playlists, background and native lyric preferences", async () => {
  const backup = parseApplicationBackup(
    JSON.stringify({
      version: "electron-migration-1",
      timestamp: 1,
      renderer: {
        "setting-store": '{"themeMode":"dark"}',
        "data-store": '{"token":"account-token"}',
      },
      electron: {
        window: { useBorderless: true },
        lyric: { config: { showTran: false, isDoubleLine: false, playedColor: "#123456" } },
      },
      businessRecords: [
        {
          namespace: "music-data/music",
          key: "localPlayList",
          data: await encodeApplicationValue([{ id: "playlist" }]),
        },
        {
          namespace: "background-data/background",
          key: "image",
          data: await encodeApplicationValue(new Blob(["image"], { type: "image/png" })),
        },
      ],
    }),
  );
  expect(backup.format).toBe("he-music-application-data");
  const setting = backup.records.find((record) => record.key === "setting-store");
  expect(JSON.parse(setting!.data.value)).toMatchObject({
    themeMode: "dark",
    desktopLyricStyle: { playedColor: "#123456" },
    desktopLyricOptions: { showTran: false, isDoubleLine: false },
  });
  expect(
    backup.records.find((record) => record.key === "native-window-appearance")?.data.value,
  ).toBe('{"useBorderless":true}');
  expect(backup.records.find((record) => record.key === "data-store")?.data.value).toContain(
    "account-token",
  );
  expect(backup.records.find((record) => record.key === "image")?.data.kind).toBe("blob");
  expect(JSON.stringify(backup)).not.toContain('"electron"');
});

it("rejects duplicate records, unknown native stores and malformed persisted states before import", () => {
  const record = {
    namespace: "renderer",
    key: "setting-store",
    data: { kind: "text", value: "{}", mediaType: "" },
  };
  const wrap = (records: unknown[]) =>
    JSON.stringify({ format: "he-music-application-data", version: 1, records });
  expect(() => parseApplicationBackup(wrap([record, record]))).toThrow("Duplicate");
  expect(() =>
    parseApplicationBackup(wrap([{ ...record, namespace: "directory-grants" }])),
  ).toThrow("Unknown");
  expect(() =>
    parseApplicationBackup(wrap([{ ...record, data: { ...record.data, value: "[]" } }])),
  ).toThrow("Invalid renderer");
  expect(() => parseApplicationBackup(wrap([{ ...record, key: "__proto__" }]))).toThrow();
  expect(() =>
    parseApplicationBackup(
      wrap([{ ...record, data: { ...record.data, value: '{"__proto__":{}}' } }]),
    ),
  ).toThrow();
});

it("keeps settings-only exports in the existing settings importer instead of clearing unrelated data", () => {
  expect(() =>
    parseApplicationBackup(
      JSON.stringify({ version: "1.0", renderer: { "setting-store": "{}" }, electron: {} }),
    ),
  ).toThrow("Unsupported");
});

it("round trips canonical download history without creating directory capabilities", async () => {
  const backup = {
    format: "he-music-application-data",
    version: 1,
    records: [
      {
        namespace: "local-data/local_download_history",
        key: "history-v1",
        data: await encodeApplicationValue({
          version: 1,
          tasks: [
            {
              id: "task",
              label: "Song",
              filename: "song.flac",
              quality: "lossless",
              targetDirectory: "/Music",
              phase: "saved",
              done: true,
              committed: true,
              received: 10,
              total: 10,
            },
          ],
        }),
      },
    ],
  };
  expect(parseApplicationBackup(JSON.stringify(backup))).toEqual(backup);
  expect(JSON.stringify(backup)).not.toMatch(/grantToken|fileId|epoch/);
});

it("keeps supported Electron lyric preferences when one old field is unsupported", () => {
  const backup = parseApplicationBackup(
    JSON.stringify({
      version: "electron-migration-1",
      renderer: { "setting-store": "{}" },
      businessRecords: [],
      electron: {
        lyric: {
          config: {
            font: { size: 12 },
            showTran: false,
            unplayedColor: "#123456",
            playedColor: "unsupported-color",
          },
        },
      },
    }),
  );
  const settings = backup.records.find((record) => record.key === "setting-store");
  expect(JSON.parse(settings!.data.value)).toMatchObject({
    desktopLyricOptions: { showTran: false, font: { size: 24 } },
    desktopLyricStyle: { unplayedColor: "#123456", playedColor: "#fe7971" },
  });
});
