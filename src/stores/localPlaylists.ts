import { defineStore } from "pinia";
import { shallowRef } from "vue";
import { createApplicationDatabase } from "@/platform/applicationStorage";
import type { SongInfo } from "@/types/main.hemusic";
import { localPlaylistSong, parseLocalPlaylists, type LocalPlaylist } from "@/utils/localPlaylist";

const database = createApplicationDatabase({ name: "music-data", storeName: "music" });
const key = "localPlayList";

export const useLocalPlaylistStore = defineStore("local-playlists", () => {
  const playlists = shallowRef<LocalPlaylist[]>([]);
  const ready = shallowRef(false);
  const failed = shallowRef(false);
  let loading: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  function load(): Promise<void> {
    if (ready.value) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      try {
        const saved = await database.getItem(key);
        playlists.value = parseLocalPlaylists(saved ?? []);
        ready.value = true;
        failed.value = false;
      } catch (error) {
        failed.value = true;
        throw error;
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  }

  function change(update: (current: LocalPlaylist[]) => LocalPlaylist[]): Promise<void> {
    const operation = tail.then(async () => {
      await load();
      const next = parseLocalPlaylists(update(parseLocalPlaylists(playlists.value)));
      await database.setItem(key, next);
      playlists.value = next;
    });
    tail = operation.catch(() => undefined);
    return operation;
  }

  async function create(
    name: string,
    songs: SongInfo[] = [],
    details: Pick<LocalPlaylist, "cover" | "description"> = { cover: "", description: "" },
  ): Promise<string> {
    const id = crypto.randomUUID();
    await change((current) => [
      ...current,
      {
        id,
        name: name.trim(),
        cover: details.cover.trim(),
        description: details.description.trim(),
        createdAt: Date.now(),
        songs: [...new Map(songs.map((song) => [song.id, localPlaylistSong(song)])).values()],
      },
    ]);
    return id;
  }

  function edit(id: string, update: (playlist: LocalPlaylist) => void): Promise<void> {
    return change((current) => {
      const playlist = current.find((item) => item.id === id);
      if (!playlist) throw new Error("Local playlist unavailable");
      update(playlist);
      return current;
    });
  }

  const update = (id: string, details: Pick<LocalPlaylist, "name" | "cover" | "description">) =>
    edit(id, (playlist) => {
      playlist.name = details.name.trim();
      playlist.cover = details.cover.trim();
      playlist.description = details.description.trim();
    });
  const rename = (id: string, name: string) =>
    edit(id, (playlist) => {
      playlist.name = name.trim();
    });
  const remove = (id: string) => change((current) => current.filter((item) => item.id !== id));
  const add = (id: string, songs: SongInfo[]) =>
    edit(id, (playlist) => {
      const existing = new Set(playlist.songs.map((song) => song.id));
      for (const song of songs) {
        if (existing.has(song.id)) continue;
        playlist.songs.push(localPlaylistSong(song));
        existing.add(song.id);
      }
    });
  const removeSongs = (id: string, songIDs: string[]) =>
    edit(id, (playlist) => {
      const removed = new Set(songIDs);
      playlist.songs = playlist.songs.filter((song) => !removed.has(song.id));
    });
  const move = (id: string, songID: string, offset: number) =>
    edit(id, (playlist) => {
      const index = playlist.songs.findIndex((song) => song.id === songID);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= playlist.songs.length) return;
      const [song] = playlist.songs.splice(index, 1);
      playlist.songs.splice(target, 0, song);
    });
  const replace = (id: string, previousID: string, song: SongInfo) =>
    edit(id, (playlist) => {
      const index = playlist.songs.findIndex((item) => item.id === previousID);
      if (index < 0) throw new Error("Local playlist song unavailable");
      if (playlist.songs.some((item, position) => item.id === song.id && position !== index)) {
        throw new Error("Duplicate local playlist song");
      }
      playlist.songs[index] = localPlaylistSong(song);
    });

  return {
    playlists,
    ready,
    failed,
    load,
    create,
    update,
    rename,
    remove,
    add,
    removeSongs,
    move,
    replace,
  };
});
