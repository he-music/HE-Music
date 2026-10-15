import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AlbumInfo,
  GetSongDetailResponse,
  MVInfo,
  PlaylistInfo,
  SongDetailSection,
  SongInfo,
} from "@/types/main.hemusic";

const { songDetailMock } = vi.hoisted(() => ({ songDetailMock: vi.fn() }));
vi.mock("@/api/song", () => ({ songDetail: songDetailMock }));
import { useSongDetail } from "./useSongDetail";

const song = (id: string, platform = "qq"): SongInfo => ({
  id,
  platform,
  name: id,
  subtitle: "",
  duration: 180,
  mv_id: "",
  album: "",
  cover: "",
  links: [],
});
const album: AlbumInfo = {
  id: "album-id",
  platform: "netease",
  name: "专辑",
  cover: "",
  loading: false,
  artists: [],
  song_count: "1",
  publish_time: "2024-01-01",
  songs: [],
  description: "",
  language: "国语",
  genre: "",
  type: 0,
  is_finished: true,
  play_count: "0",
};
const mv: MVInfo = {
  id: "mv-id",
  platform: "bilibili",
  name: "MV",
  cover: "",
  loading: false,
  links: [],
  type: 0,
  play_count: "0",
  creator: "歌手",
  duration: 180,
  description: "",
};
const playlist: PlaylistInfo = {
  id: "playlist-id",
  platform: "kugou",
  name: "歌单",
  cover: "",
  loading: false,
  creator: "用户",
  song_count: "1",
  play_count: "0",
  songs: [],
  description: "",
  categories: [],
};
const section = (title: string, id: string, platform = "qq"): SongDetailSection => ({
  resource_type: "song",
  title,
  songs: [song(id, platform)],
});
const response = (id: string): GetSongDetailResponse => ({
  song: song(id),
  fields: [{ label: "自定义信息", value: id }],
  sections: [section(id, `${id}-related`)],
});
const deferred = () => {
  let resolve!: (response: GetSongDetailResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<GetSongDetailResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  await nextTick();
  await nextTick();
};
const scopes: ReturnType<typeof effectScope>[] = [];
const setup = (active = true) => {
  const scope = effectScope();
  scopes.push(scope);
  const id = ref("current");
  const platform = ref("qq");
  const enabled = ref(active);
  const onError = vi.fn();
  const state = scope.run(() => useSongDetail(id, platform, enabled, onError))!;
  return { ...state, id, platform, enabled, onError, scope };
};

beforeEach(() => songDetailMock.mockReset());
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()));

describe("歌曲详情", () => {
  it("一次请求保留字段原文、区块顺序和重复类型，以及资源自身的 id、platform", async () => {
    const data: GetSongDetailResponse = {
      song: song("current"),
      fields: [
        { label: "自定义日期", value: "1704067200" },
        { label: "语言", value: "后端格式化文本" },
        { label: "自定义日期", value: "2024-01-01" },
      ],
      sections: [
        section("其他版本", "version", "kuwo"),
        { resource_type: "playlist", title: "相关歌单", playlists: [playlist] },
        { resource_type: "album", title: "收录专辑", albums: [album] },
        { resource_type: "mv", title: "音乐视频", mvs: [mv] },
        section("其他版本", "another-version", "netease"),
      ],
    };
    songDetailMock.mockResolvedValue(data);
    const state = setup();
    await flush();

    expect(songDetailMock).toHaveBeenCalledExactlyOnceWith("current", "qq");
    expect(state.song.value).toBe(data.song);
    expect(state.fields.value).toBe(data.fields);
    expect(state.sections.value).toEqual(data.sections);
    state.sections.value.forEach((item, index) => expect(item).toBe(data.sections?.[index]));
    expect(state.onError).not.toHaveBeenCalled();
  });

  it.each([undefined, null, []])(
    "fields 缺失、为 null 或为空时保持歌曲和关联内容：%j",
    async (fields) => {
      const data = { ...response("current"), fields };
      songDetailMock.mockResolvedValue(data);
      const state = setup();
      await flush();
      expect(state.song.value).toBe(data.song);
      expect(state.fields.value).toEqual([]);
      expect(state.sections.value).toEqual(data.sections);
      expect(state.onError).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, []])(
    "sections 缺失、为 null 或为空时仍保留 song 和 fields：%j",
    async (sections) => {
      const data = { ...response("current"), sections };
      songDetailMock.mockResolvedValue(data);
      const state = setup();
      await flush();
      expect(state.song.value).toBe(data.song);
      expect(state.fields.value).toBe(data.fields);
      expect(state.sections.value).toEqual([]);
      expect(state.onError).not.toHaveBeenCalled();
    },
  );

  it("跳过未知类型及各资源的缺失、null、空数组，只读取类型对应的资源数组", async () => {
    const skipped: SongDetailSection[] = [
      { resource_type: "future", title: "未知资源", songs: [song("unknown")] },
      { resource_type: "song", title: "无歌曲", albums: [album] },
    ];
    for (const resource_type of ["song", "album", "mv", "playlist"]) {
      for (const empty of [undefined, null, []]) {
        skipped.push({
          resource_type,
          title: "空区块",
          songs: empty,
          albums: empty,
          mvs: empty,
          playlists: empty,
        });
      }
    }
    const valid = section("保留标题", "valid");
    songDetailMock.mockResolvedValue({ song: song("current"), sections: [...skipped, valid] });
    const state = setup();
    await flush();
    expect(state.sections.value).toEqual([valid]);
    expect(state.onError).not.toHaveBeenCalled();
  });

  it("切换歌曲及平台时清空旧详情，迟到响应不能覆盖新歌曲", async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    songDetailMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const state = setup();
    state.id.value = "new";
    state.platform.value = "netease";
    await flush();
    expect(state.song.value).toBeNull();
    expect(state.fields.value).toEqual([]);
    expect(state.sections.value).toEqual([]);
    expect(songDetailMock).toHaveBeenCalledTimes(2);
    expect(songDetailMock).toHaveBeenLastCalledWith("new", "netease");
    const latest = response("new");
    newRequest.resolve(latest);
    await flush();
    oldRequest.resolve(response("old"));
    await flush();
    expect(state.song.value).toBe(latest.song);
    expect(state.fields.value).toBe(latest.fields);
    expect(state.sections.value).toEqual(latest.sections);
  });

  it("旧请求失败不弹错误，当前请求失败通过详情错误回调处理", async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    songDetailMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const state = setup();
    state.id.value = "new";
    await flush();
    oldRequest.reject(new Error("旧请求失败"));
    await flush();
    expect(state.onError).not.toHaveBeenCalled();
    newRequest.reject(new Error("详情请求失败"));
    await flush();
    expect(state.onError).toHaveBeenCalledExactlyOnceWith(new Error("详情请求失败"));
  });

  it("离开页面清空详情并忽略在途响应", async () => {
    songDetailMock.mockResolvedValueOnce(response("current"));
    const state = setup();
    await flush();
    expect(state.song.value?.id).toBe("current");
    state.enabled.value = false;
    await flush();
    expect(state.song.value).toBeNull();
    expect(state.fields.value).toEqual([]);
    expect(state.sections.value).toEqual([]);
    const pending = deferred();
    songDetailMock.mockReturnValueOnce(pending.promise);
    state.enabled.value = true;
    await flush();
    state.enabled.value = false;
    await flush();
    pending.resolve(response("late"));
    await flush();
    expect(state.song.value).toBeNull();
  });

  it("页面未激活时不请求，作用域销毁后忽略响应", async () => {
    const pending = deferred();
    songDetailMock.mockReturnValue(pending.promise);
    const state = setup(false);
    expect(songDetailMock).not.toHaveBeenCalled();
    state.enabled.value = true;
    await flush();
    expect(songDetailMock).toHaveBeenCalledTimes(1);
    state.scope.stop();
    pending.resolve(response("late"));
    await flush();
    expect(state.song.value).toBeNull();
    expect(state.onError).not.toHaveBeenCalled();
  });
});
