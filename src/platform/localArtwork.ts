import { shallowRef } from "vue";
import type { SongInfo } from "@/types/main.hemusic";

type ArtworkReader = (songID: string, platform: string, relativePath: string) => string | undefined;
const activeReader = shallowRef<ArtworkReader>();

/** 封面只通过派生 getter 提供；不会写入 Pinia 的持久化 playSong。 */
export function localArtworkForSong(
  song: Pick<SongInfo, "id" | "platform" | "path">,
): string | undefined {
  if (!song.path) return undefined;
  try {
    return activeReader.value?.(song.id, song.platform, song.path);
  } catch {
    return undefined;
  }
}

export function ownsLocalArtworkReader(reader: ArtworkReader): boolean {
  return activeReader.value === reader;
}

/** 旧主壳的处置不能清除后来安装的新 owner。 */
export function installLocalArtworkReader(reader: ArtworkReader): () => void {
  activeReader.value = reader;
  return () => {
    if (activeReader.value === reader) activeReader.value = undefined;
  };
}
