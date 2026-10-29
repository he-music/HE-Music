import { computed, effectScope, onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { SongInfo } from "@/types/main.hemusic";
import { filesSession } from "@/platform/filesSession";
import { localFilesSession, nativeLocalEntry } from "@/platform/localFilesSession";
import { readLocalDisplay } from "@/platform/localDisplayRead";
import { useSettingStore } from "@/stores";
import {
  VisibleArtworkCache,
  visibleArtworkKey,
  type VisibleArtworkTarget,
} from "../platform/visibleArtworkCache";

interface SharedCache {
  owner: object;
  cache: VisibleArtworkCache;
  users: number;
  stop: () => void;
}
let shared: SharedCache | undefined;

/** Each mounted row retains the owner; idle cache bytes die with the last row. */
export function useLocalArtwork(song: Ref<SongInfo>, enabled?: Ref<boolean>) {
  const settings = useSettingStore();
  const url = shallowRef<string>();
  let owned: SharedCache | undefined;
  let release = () => {};
  let stopURL = () => {};
  const active = computed(() => enabled?.value !== false && settings.showLocalCover);
  const target = computed<VisibleArtworkTarget | undefined>(() => {
    const owner = filesSession.value;
    const current = song.value;
    const entry = nativeLocalEntry(current.id);
    if (
      !active.value ||
      !owner?.ready.value ||
      !current.path ||
      !entry ||
      entry.relativePath !== current.path ||
      entry.ref.relativePath !== current.path ||
      !owner.directories.value.some((grant) => grant.token === entry.ref.grantToken)
    )
      return;
    return {
      entry,
      songID: current.id,
      platform: current.platform,
      relativePath: current.path,
      ref: { ...entry.ref },
    };
  });
  const current = (item: VisibleArtworkTarget) => {
    const owner = filesSession.value;
    const entry = nativeLocalEntry(item.songID);
    return Boolean(
      active.value &&
      owned?.owner === owner &&
      owner?.ready.value &&
      entry &&
      entry.relativePath === item.relativePath &&
      entry.ref.grantToken === item.ref.grantToken &&
      entry.ref.relativePath === item.ref.relativePath &&
      entry.ref.fileId === item.ref.fileId &&
      entry.ref.version === item.ref.version &&
      owner.directories.value.some((grant) => grant.token === item.ref.grantToken),
    );
  };
  const dropLease = () => {
    stopURL();
    release();
    stopURL = () => {};
    release = () => {};
    url.value = undefined;
  };
  const dropOwner = () => {
    if (!owned) return;
    owned.users--;
    if (!owned.users) {
      owned.stop();
      owned.cache.dispose();
      if (shared === owned) shared = undefined;
    }
    owned = undefined;
  };
  const retain = () => {
    const owner = filesSession.value;
    if (owned?.owner === owner) return;
    dropOwner();
    if (!owner || !active.value) return;
    if (!shared || shared.owner !== owner) {
      shared?.cache.dispose();
      shared?.stop();
      const created: SharedCache = {
        owner,
        users: 0,
        stop: () => {},
        cache: new VisibleArtworkCache({
          read: (item) => readLocalDisplay(owner, item.ref, "artwork", item.entry),
          isCurrent: (item) => {
            const entry = nativeLocalEntry(item.songID);
            return Boolean(
              settings.showLocalCover &&
              filesSession.value === owner &&
              owner.ready.value &&
              entry &&
              entry === item.entry &&
              entry.relativePath === item.relativePath &&
              entry.ref.grantToken === item.ref.grantToken &&
              entry.ref.relativePath === item.ref.relativePath &&
              entry.ref.fileId === item.ref.fileId &&
              entry.ref.version === item.ref.version &&
              owner.directories.value.some((grant) => grant.token === item.ref.grantToken),
            );
          },
          createURL: (bytes, mime) => URL.createObjectURL(new Blob([bytes], { type: mime })),
          revokeURL: (value) => URL.revokeObjectURL(value),
        }),
      };
      const cacheScope = effectScope(true);
      cacheScope.run(() =>
        watch(
          () => [
            filesSession.value,
            owner.ready.value,
            owner.directories.value,
            localFilesSession.value?.entries.value,
            settings.showLocalCover,
          ],
          () => created.cache.prune(),
          { flush: "sync" },
        ),
      );
      created.stop = () => cacheScope.stop();
      shared = created;
    }
    owned = shared;
    owned.users++;
  };
  const stop = watch(
    // A boolean authorization plus identity key avoids restarting every row when
    // an unrelated directory changes. Owner replacement remains an explicit fence.
    [
      () => filesSession.value,
      () => active.value,
      () => target.value && visibleArtworkKey(target.value),
      () => target.value?.entry,
    ],
    () => {
      dropLease();
      if (!active.value) {
        dropOwner();
        return;
      }
      retain();
      const item = target.value;
      if (!owned || !item || !current(item)) return;
      const lease = owned.cache.acquire(item);
      release = lease.release;
      url.value = lease.url.value;
      stopURL = watch(
        lease.url,
        (value) => {
          url.value = value;
        },
        { flush: "sync" },
      );
    },
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(() => {
    stop();
    dropLease();
    dropOwner();
  });
  return { url };
}
