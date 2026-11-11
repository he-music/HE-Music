import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { localEntry, localSong } from "@/test/fixtures/localMedia";
import { useLocalPlaylistStore } from "./localPlaylists";

const storage = vi.hoisted(() => ({ value: null as unknown, write: vi.fn() }));
vi.mock("@/platform/applicationStorage", () => ({
  applicationStorage: { getItem: () => null, setItem: vi.fn() },
  createApplicationDatabase: () => ({
    getItem: async () => storage.value,
    setItem: async (_key: string, value: unknown) => {
      await storage.write(value);
      storage.value = structuredClone(value);
      return value;
    },
  }),
}));
const song = (name: string) => ({
  ...localSong(localEntry()),
  id: `mygo-local:path:${encodeURIComponent("/Music")}/${name}.mp3`,
  path: `${name}.mp3`,
  name,
});

beforeEach(() => {
  setActivePinia(createPinia());
  storage.value = null;
  storage.write.mockReset();
});

describe("本地歌单持久化", () => {
  it("串行合并并发修改，重启后恢复顺序、标题和歌曲", async () => {
    const store = useLocalPlaylistStore();
    const id = await store.create("  我的歌单  ", [song("a"), song("a")]);
    await Promise.all([store.add(id, [song("b")]), store.add(id, [song("c")])]);
    await store.move(id, song("c").id, -1);
    await store.rename(id, "新名称");
    setActivePinia(createPinia());
    const restored = useLocalPlaylistStore();
    await restored.load();
    expect(restored.playlists[0]).toMatchObject({ id, name: "新名称" });
    expect(restored.playlists[0].songs.map((item) => item.name)).toEqual(["a", "c", "b"]);
  });

  it("写入失败不发布修改，后续操作仍可重试", async () => {
    const store = useLocalPlaylistStore();
    const id = await store.create("歌单", [song("a")]);
    storage.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.add(id, [song("b")])).rejects.toThrow("disk full");
    expect(store.playlists[0].songs).toHaveLength(1);
    await store.add(id, [song("b")]);
    expect(store.playlists[0].songs).toHaveLength(2);
  });

  it("损坏数据不会被空歌单覆盖", async () => {
    storage.value = [{ id: "broken", name: "歌单", songs: [{ id: "bad" }] }];
    const original = structuredClone(storage.value);
    const store = useLocalPlaylistStore();
    await expect(store.load()).rejects.toThrow();
    await expect(store.create("新歌单")).rejects.toThrow();
    expect(store.failed).toBe(true);
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.value).toEqual(original);
  });

  it("重新关联移动后的文件，移除记录不删除文件", async () => {
    const store = useLocalPlaylistStore();
    const id = await store.create("歌单", [song("a"), song("b")]);
    await store.replace(id, song("a").id, song("moved"));
    await store.removeSongs(id, [song("b").id]);
    expect(store.playlists[0].songs.map((item) => item.name)).toEqual(["moved"]);
    await store.remove(id);
    expect(storage.value).toEqual([]);
  });

  it("拒绝在线歌曲、重复关联及无效名称", async () => {
    const store = useLocalPlaylistStore();
    await expect(store.create(" ")).rejects.toThrow();
    const id = await store.create("歌单", [song("a"), song("b")]);
    await expect(store.add(id, [{ ...song("c"), platform: "online" }])).rejects.toThrow();
    await expect(store.replace(id, song("a").id, song("b"))).rejects.toThrow();
    expect(store.playlists[0].songs).toHaveLength(2);
  });

  it("持久化歌曲会剥离原生授权及运行期字段", async () => {
    const store = useLocalPlaylistStore();
    const withCapability = { ...song("a"), ref: localEntry().ref, secret: "transient" };
    await store.create("歌单", [withCapability]);
    expect(JSON.stringify(storage.value)).not.toContain("grantToken");
    expect(JSON.stringify(storage.value)).not.toContain("transient");
  });
  it("保存封面和简介，编辑后恢复时保留创建时间和歌曲", async () => {
    const store = useLocalPlaylistStore();
    const id = await store.create("歌单", [song("a")], {
      cover: "https://cover.fixture.invalid/a.jpg",
      description: "第一段简介",
    });
    const createdAt = store.playlists[0].createdAt;
    await store.update(id, {
      name: "修改名称",
      cover: "https://cover.fixture.invalid/b.jpg",
      description: "新简介",
    });
    setActivePinia(createPinia());
    const restored = useLocalPlaylistStore();
    await restored.load();
    expect(restored.playlists[0]).toMatchObject({
      id,
      name: "修改名称",
      cover: "https://cover.fixture.invalid/b.jpg",
      description: "新简介",
      createdAt,
    });
    expect(restored.playlists[0].songs).toHaveLength(1);
  });

  it("已有歌单缺少封面和简介时仍能读取并编辑", async () => {
    storage.value = [{ id: "old", name: "已有歌单", songs: [song("a")] }];
    const store = useLocalPlaylistStore();
    await store.load();
    expect(store.playlists[0]).toMatchObject({ id: "old", cover: "", description: "" });
    await store.update("old", { name: "已有歌单", cover: "", description: "补充简介" });
    expect(store.playlists[0].songs[0].id).toBe(song("a").id);
  });
  it("导入的图片随歌单持久化，重命名不会丢失，移除后恢复默认封面", async () => {
    const cover = "data:image/jpeg;base64,imported";
    const store = useLocalPlaylistStore();
    const id = await store.create("图片封面", [], { cover, description: "" });
    await store.rename(id, "新名称");
    setActivePinia(createPinia());
    const restored = useLocalPlaylistStore();
    await restored.load();
    expect(restored.playlists[0].cover).toBe(cover);
    await restored.update(id, { name: "新名称", cover: "", description: "" });
    expect(restored.playlists[0].cover).toBe("");
    expect(JSON.stringify(storage.value)).not.toContain("data:image");
  });
});
