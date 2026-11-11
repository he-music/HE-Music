import { computed, type Ref } from "vue";
import type { SongInfo } from "@/types/main.hemusic";
import { filesSession } from "@/platform/filesSession";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import { localResourceURL } from "@/platform/localResource";
import { useSettingStore } from "@/stores";

/** Images are loaded by the browser only while the row is visible. */
export function useLocalArtwork(song: Ref<SongInfo | null | undefined>, enabled?: Ref<boolean>) {
  const settings = useSettingStore();
  const url = computed(() => {
    if (enabled?.value === false || !settings.showLocalCover) return undefined;
    const owner = filesSession.value;
    const current = song.value;
    if (!current?.path) return undefined;
    const entry = nativeLocalEntry(current.id);
    if (
      !owner?.ready.value ||
      !entry ||
      entry.relativePath !== current.path ||
      !owner.directories.value.some((grant) => grant.token === entry.ref.grantToken)
    )
      return undefined;
    return localResourceURL("artwork", entry);
  });
  return { url };
}
