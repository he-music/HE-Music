import {
  applicationStorage,
  applicationDatabases,
  createApplicationDatabase,
  encodeApplicationValue,
  decodeApplicationValue,
  flushApplicationWrites,
} from "./applicationStorage";
import type { ApplicationBackup, ApplicationStorageRecord, StorageValue } from "./mygo.bindings";
import { parseDesktopLyricStyle, createDefaultDesktopLyricStyle } from "./desktopLyricStyle";
import { parseDesktopLyricOptions, createDefaultDesktopLyricOptions } from "./desktopLyricOptions";
import { localDownloadSnapshot } from "./localDownloadPersistence";

export const applicationBackupMaxBytes = 128 * 1024 * 1024;
const backupFormat = "he-music-application-data";
const arrayKeys: Record<string, readonly string[]> = {
  "music-data/music": [
    "playList",
    "originalPlayList",
    "historyList",
    "localPlayList",
    "downloadingSongs",
  ],
  "user-data/user": ["songs", "playlists", "artists", "albums", "mvs"],
  "local-data/local": ["local-songs"],
};
const rendererJSONKeys = new Set([
  "setting-store",
  "shortcut-store",
  "data-store",
  "music-store",
  "status-store",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseJSON(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown) => {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("Invalid backup key");
    return value;
  });
}

function validateRecord(value: unknown): ApplicationStorageRecord {
  if (
    !object(value) ||
    typeof value.namespace !== "string" ||
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    value.key.length > 1024 ||
    !object(value.data)
  )
    throw new Error("Invalid backup record");
  const { namespace, key, data } = value;
  if (
    typeof data.kind !== "string" ||
    typeof data.value !== "string" ||
    typeof data.mediaType !== "string"
  ) {
    throw new Error("Invalid backup value");
  }
  const encoded: StorageValue = { kind: data.kind, value: data.value, mediaType: data.mediaType };
  if (namespace === "renderer") {
    if (data.kind !== "text" || ["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("Invalid renderer record");
    if (rendererJSONKeys.has(key) && !object(parseJSON(data.value)))
      throw new Error("Invalid renderer state");
    if (key === "native-window-appearance") {
      const appearance = parseJSON(data.value);
      if (!object(appearance) || typeof appearance.useBorderless !== "boolean")
        throw new Error("Invalid window appearance");
    }
  } else if (Object.hasOwn(arrayKeys, namespace)) {
    if (
      !arrayKeys[namespace].includes(key) ||
      data.kind !== "json" ||
      !Array.isArray(parseJSON(data.value))
    ) {
      throw new Error("Invalid list record");
    }
  } else if (namespace === "background-data/background") {
    if (key !== "image" || data.kind !== "blob") throw new Error("Invalid background record");
    decodeApplicationValue(encoded);
  } else if (namespace === "local-data/local_download_history") {
    if (key !== "history-v1" || data.kind !== "json") throw new Error("Invalid task history");
    const history = parseJSON(data.value);
    if (!object(history) || history.version !== 1 || !Array.isArray(history.tasks))
      throw new Error("Invalid task history");
    const tasks = history.tasks.map(localDownloadSnapshot);
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
      throw new Error("Duplicate task");
    encoded.value = JSON.stringify({ version: 1, tasks });
  } else throw new Error("Unknown backup namespace");
  return { namespace, key, data: encoded };
}

function migrateElectronLyrics(records: ApplicationStorageRecord[], legacy: unknown) {
  if (!object(legacy)) return;
  if (object(legacy.window) && typeof legacy.window.useBorderless === "boolean") {
    const data = {
      kind: "text",
      value: JSON.stringify({ useBorderless: legacy.window.useBorderless }),
      mediaType: "",
    };
    const existing = records.find(
      (record) => record.namespace === "renderer" && record.key === "native-window-appearance",
    );
    if (existing) existing.data = data;
    else records.push({ namespace: "renderer", key: "native-window-appearance", data });
  }
  if (!object(legacy.lyric) || !object(legacy.lyric.config)) return;
  const config = legacy.lyric.config;
  const record = records.find(
    (record) => record.namespace === "renderer" && record.key === "setting-store",
  );
  const settings = record ? parseJSON(record.data.value) : {};
  if (!object(settings)) throw new Error("Invalid legacy settings");
  let style =
    parseDesktopLyricStyle(settings.desktopLyricStyle) ?? createDefaultDesktopLyricStyle();
  for (const key of ["playedColor", "unplayedColor", "shadowColor", "textBackgroundMask"]) {
    if (config[key] !== undefined)
      style = parseDesktopLyricStyle({ ...style, [key]: config[key] }) ?? style;
  }
  let options =
    parseDesktopLyricOptions(settings.desktopLyricOptions) ?? createDefaultDesktopLyricOptions();
  for (const key of [
    "font",
    "isDoubleLine",
    "position",
    "limitBounds",
    "showYrc",
    "showTran",
    "animation",
    "alwaysShowPlayInfo",
  ]) {
    if (config[key] !== undefined)
      options = parseDesktopLyricOptions({ ...options, [key]: config[key] }) ?? options;
  }
  settings.desktopLyricStyle = style;
  settings.desktopLyricOptions = options;
  if (record) record.data.value = JSON.stringify(settings);
  else
    records.push({
      namespace: "renderer",
      key: "setting-store",
      data: { kind: "text", value: JSON.stringify(settings), mediaType: "" },
    });
}

export function parseApplicationBackup(text: string): ApplicationBackup {
  if (new TextEncoder().encode(text).byteLength > applicationBackupMaxBytes)
    throw new Error("Backup too large");
  const input = parseJSON(text);
  if (!object(input)) throw new Error("Invalid application backup");
  let rawRecords: unknown[];
  if (input.format === backupFormat && input.version === 1 && Array.isArray(input.records)) {
    rawRecords = input.records;
  } else if (
    typeof input.version === "string" &&
    object(input.renderer) &&
    object(input.electron) &&
    Array.isArray(input.businessRecords)
  ) {
    // The migration helper extends the old Electron envelope with business
    // records. Settings-only exports remain in the existing settings importer.
    rawRecords = Object.entries(input.renderer).map(([key, value]) => ({
      namespace: "renderer",
      key,
      data: { kind: "text", value, mediaType: "" },
    }));
    if (Array.isArray(input.businessRecords)) rawRecords.push(...input.businessRecords);
  } else throw new Error("Unsupported application backup");
  if (rawRecords.length > 20000) throw new Error("Too many backup records");
  const records = rawRecords.map(validateRecord);
  const seen = new Set<string>();
  for (const record of records) {
    const id = JSON.stringify([record.namespace, record.key]);
    if (seen.has(id)) throw new Error("Duplicate backup record");
    seen.add(id);
  }
  migrateElectronLyrics(records, input.electron);
  return { format: backupFormat, version: 1, records };
}

export async function exportApplicationBackup(mygo: boolean): Promise<ApplicationBackup> {
  await flushApplicationWrites();
  if (mygo) {
    const { DesktopStorage } = await import("./mygo.bindings");
    return parseApplicationBackup(JSON.stringify(await DesktopStorage.export()));
  }
  const records: ApplicationStorageRecord[] = [];
  for (let i = 0; i < applicationStorage.length; i++) {
    const key = applicationStorage.key(i);
    if (key === null) continue;
    const value = applicationStorage.getItem(key);
    if (value !== null)
      records.push({ namespace: "renderer", key, data: { kind: "text", value, mediaType: "" } });
  }
  for (const options of applicationDatabases) {
    const db = createApplicationDatabase(options);
    for (const key of await db.keys()) {
      const value = await db.getItem(key);
      records.push({
        namespace: `${options.name}/${options.storeName}`,
        key,
        data: await encodeApplicationValue(value),
      });
    }
  }
  // Validate the exact file we produce, too; export must never claim portability
  // for runtime handles or an unsupported persisted record.
  return parseApplicationBackup(JSON.stringify({ format: backupFormat, version: 1, records }));
}
