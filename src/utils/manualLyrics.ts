import type { LyricInfo } from "@/types/main.hemusic";
import { createApplicationDatabase, manualLyricsDatabase } from "@/platform/applicationStorage";
import { ref } from "vue";
import { isManualLyric } from "./manualLyricRecord";

const database = createApplicationDatabase(manualLyricsDatabase);
export const manualLyricRevision = ref(0);

export const manualLyrics = {
  async get(key: string) {
    const value = await database.getItem(key);
    return isManualLyric(value) ? value : null;
  },
  async save(key: string, { id, platform, lyric, trans, roma }: LyricInfo) {
    await database.setItem(key, { id, platform, lyric, trans, roma });
    manualLyricRevision.value++;
  },
  async remove(key: string) {
    await database.removeItem(key);
    manualLyricRevision.value++;
  },
  async clear() {
    await database.clear();
    manualLyricRevision.value++;
  },
  async usage() {
    const keys = await database.keys();
    const encoder = new TextEncoder();
    let count = 0;
    let bytes = 0;
    for (const key of keys) {
      const value = await this.get(key);
      if (!value) throw new Error("无法读取手动歌词记录");
      count++;
      bytes += encoder.encode(key + JSON.stringify(value)).byteLength;
    }
    return { count, bytes };
  },
};
