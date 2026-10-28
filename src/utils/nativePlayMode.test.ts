import { reactive, watch } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { SongInfo } from "@/types/main.hemusic";
import {
  createNativePlayModeCoordinator,
  type NativePlayModeAdapter,
  type NativePlayModeRequest,
  type NativePlayModeSnapshot,
  type NativePlayModeState,
} from "./nativePlayMode";

const song = (id: string, platform = "netease"): SongInfo => ({
  id,
  platform,
  name: id,
  subtitle: "",
  duration: 100,
  mv_id: "",
  album: { id: "album", name: "album" },
  links: [],
  cover: "",
});
const a = song("1");
const b = song("1", "qq");
const c = song("2");
const keys = (songs: SongInfo[]) => songs.map(({ id, platform }) => `${platform}:${id}`);
const current = () => true;

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred 未初始化");
  };
  let reject: (error: unknown) => void = () => {
    throw new Error("deferred 未初始化");
  };
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const setup = (overrides: Partial<NativePlayModeState> = {}, useReactive = true) => {
  // 保留真实 Vue proxy，验证 snapshot 能与响应式数组和嵌套歌曲隔离。
  const initial: NativePlayModeState = {
    mode: "repeat",
    playList: [a, b, c],
    originalPlayList: [],
    playIndex: 1,
    currentSong: b,
    revision: 0,
    ...overrides,
  };
  const state = useReactive ? reactive(initial) : initial;
  const commits: NativePlayModeSnapshot[] = [];
  const saved: NativePlayModeSnapshot[] = [];
  const adapter: NativePlayModeAdapter = {
    read: vi.fn(() => state),
    readOriginal: vi.fn(async () => state.originalPlayList),
    shuffle: vi.fn((songs) => [...songs].reverse()),
    commit: vi.fn((snapshot) => {
      commits.push(snapshot);
      Object.assign(state, snapshot, { revision: Symbol() });
    }),
    persist: vi.fn(async (snapshot) => {
      saved.push(snapshot);
    }),
  };
  const coordinator = createNativePlayModeCoordinator(adapter);
  return { state, commits, saved, adapter, coordinator };
};

describe("nativePlayMode", () => {
  it("rebases a valid queued request only across this coordinator's synchronous commit", async () => {
    const { adapter, coordinator, state } = setup({ mode: "shuffle", originalPlayList: [a, b, c] });
    const pending = deferred<SongInfo[] | null>();
    adapter.readOriginal = vi.fn(() => pending.promise);
    const first = coordinator.request({ target: "repeat", isCurrent: current });
    const queued = coordinator.request({ target: "shuffle", isCurrent: current });
    pending.resolve([a, b, c]);
    expect(await first).toEqual({ status: "applied", mode: "repeat" });
    expect(await queued).toEqual({ status: "applied", mode: "shuffle" });
    expect(state.mode).toBe("shuffle");
    expect(adapter.commit).toHaveBeenCalledTimes(2);
  });
  it("does not reauthorize an externally changed queued boundary when the active read ends", async () => {
    const { adapter, coordinator, state } = setup({ mode: "shuffle", originalPlayList: [a, b, c] });
    const pending = deferred<SongInfo[] | null>();
    adapter.readOriginal = vi.fn(() => pending.promise);
    const first = coordinator.request({ target: "repeat", isCurrent: current });
    const queued = coordinator.request({ target: "repeat-once", isCurrent: current });
    state.revision = Symbol();
    pending.resolve([a, b, c]);
    expect(await first).toEqual({ status: "skipped" });
    expect(await queued).toEqual({ status: "skipped" });
    expect(adapter.commit).not.toHaveBeenCalled();
  });
  it("keeps the real persist fence when the post-commit queued boundary cannot be read", async () => {
    const { adapter, coordinator, state } = setup({ mode: "shuffle", originalPlayList: [a, b, c] });
    const reading = deferred<SongInfo[] | null>();
    const saving = deferred<void>();
    adapter.readOriginal = vi.fn(() => reading.promise);
    adapter.persist = vi.fn(() => saving.promise);
    const commit = adapter.commit;
    let readFails = false;
    adapter.commit = (snapshot) => {
      commit(snapshot);
      readFails = true;
    };
    adapter.read = () => {
      if (readFails) {
        readFails = false;
        throw new Error("fixture read");
      }
      return state;
    };
    const first = coordinator.request({ target: "repeat", isCurrent: current });
    const queued = coordinator.request({ target: "shuffle", isCurrent: current });
    reading.resolve([a, b, c]);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(await coordinator.request({ target: "repeat-once", isCurrent: current })).toEqual({
      status: "busy",
    });
    saving.resolve();
    expect(await first).toEqual({ status: "applied", mode: "repeat" });
    expect(await queued).toEqual({ status: "skipped" });
    expect(adapter.persist).toHaveBeenCalledOnce();
  });
  it("captures a queued target before the caller reuses its request object", async () => {
    const { state, adapter, coordinator } = setup();
    const gate = deferred<void>();
    adapter.persist = vi.fn(() => gate.promise);
    const active = coordinator.request({ target: "repeat-once", isCurrent: current });
    const request: NativePlayModeRequest = { target: "shuffle", isCurrent: current };
    const queued = coordinator.request(request);
    request.target = "repeat";
    gate.resolve();
    await active;
    expect(await queued).toEqual({ status: "applied", mode: "shuffle" });
    expect(state.mode).toBe("shuffle");
  });
  it("keeps the original occurrence guard while waiting for restore", async () => {
    const { adapter, coordinator } = setup({ mode: "shuffle", originalPlayList: [a, b, c] });
    const gate = deferred<SongInfo[] | null>();
    adapter.readOriginal = vi.fn(() => gate.promise);
    let valid = true;
    const request: NativePlayModeRequest = { target: "repeat", isCurrent: () => valid };
    const result = coordinator.request(request);
    valid = false;
    request.isCurrent = current;
    gate.resolve([a, b, c]);
    expect(await result).toEqual({ status: "skipped" });
    expect(adapter.commit).not.toHaveBeenCalled();
  });
  it("循环三种模式，备份和恢复原序，并按 id + platform 定位", async () => {
    const { state, adapter, coordinator, commits } = setup();
    expect(await coordinator.request({ isCurrent: current })).toEqual({
      status: "applied",
      mode: "repeat-once",
    });
    expect(adapter.shuffle).not.toHaveBeenCalled();
    await coordinator.request({ target: false, isCurrent: current });
    expect(state.mode).toBe("shuffle");
    expect(keys(state.playList)).toEqual(["netease:2", "qq:1", "netease:1"]);
    expect(keys(state.originalPlayList)).toEqual(["netease:1", "qq:1", "netease:2"]);
    expect(state.playIndex).toBe(1);
    state.currentSong = a;
    await coordinator.request({ isCurrent: current });
    expect(state.mode).toBe("repeat");
    expect(keys(state.playList)).toEqual(["netease:1", "qq:1", "netease:2"]);
    expect(state.playIndex).toBe(0);
    expect(state.originalPlayList).toEqual([]);
    expect(commits).toHaveLength(3);
  });

  it("显式目标直接进入 shuffle，同模式无提交、重排或持久化", async () => {
    const { state, adapter, coordinator } = setup();
    await coordinator.request({ target: "shuffle", isCurrent: current });
    expect(state.mode).toBe("shuffle");
    const list = state.playList;
    expect(await coordinator.request({ target: "shuffle", isCurrent: current })).toEqual({
      status: "skipped",
    });
    expect(state.playList).toBe(list);
    expect(adapter.shuffle).toHaveBeenCalledTimes(1);
    expect(adapter.commit).toHaveBeenCalledTimes(1);
    expect(adapter.persist).toHaveBeenCalledTimes(1);
  });

  it.each([{ list: [] }, { list: [a] }])("空列表或单曲保持已有顺序与索引：%j", async ({ list }) => {
    const { state, adapter, coordinator } = setup({ playList: list, playIndex: 0 });
    await coordinator.request({ target: "shuffle", isCurrent: current });
    expect(keys(state.playList)).toEqual(keys(list));
    expect(state.playIndex).toBe(0);
    expect(state.originalPlayList).toEqual([]);
    expect(adapter.shuffle).not.toHaveBeenCalled();
  });

  it("shuffle 提交时读取当前歌曲，而非重排前捕获的歌曲", async () => {
    const { state, adapter, coordinator } = setup();
    adapter.shuffle = (songs) => {
      state.currentSong = c;
      return [...songs].reverse();
    };
    await coordinator.request({ target: "shuffle", isCurrent: current });
    expect(state.playIndex).toBe(0);
  });

  it("恢复等待读取期间切歌，提交时采用新的歌曲与平台", async () => {
    const read = deferred<SongInfo[] | null>();
    const { state, adapter, coordinator } = setup({ mode: "shuffle", playList: [c, b, a] });
    adapter.readOriginal = () => read.promise;
    const result = coordinator.request({ target: "repeat-once", isCurrent: current });
    state.currentSong = a;
    state.playIndex = 2;
    read.resolve([a, b, c]);
    expect(await result).toEqual({ status: "applied", mode: "repeat-once" });
    expect(state.playIndex).toBe(0);
    expect(state.originalPlayList).toEqual([]);
  });

  it.each([null, song("missing")])("恢复后无匹配歌曲时回退索引 0：%j", async (currentSong) => {
    const { state, coordinator } = setup({
      mode: "shuffle",
      originalPlayList: [a, b, c],
      currentSong,
      playIndex: 2,
    });
    await coordinator.request({ target: "repeat", isCurrent: current });
    expect(state.playIndex).toBe(0);
  });

  it("进入 shuffle 无匹配歌曲时沿用当前索引；缺失原列表时退出仍清理备份", async () => {
    const { state, adapter, coordinator } = setup({ currentSong: song("missing"), playIndex: 2 });
    await coordinator.request({ target: "shuffle", isCurrent: current });
    expect(state.playIndex).toBe(2);
    adapter.readOriginal = async () => null;
    await coordinator.request({ target: "repeat", isCurrent: current });
    expect(keys(state.playList)).toEqual(["netease:2", "qq:1", "netease:1"]);
    expect(state.originalPlayList).toEqual([]);
    expect(state.playIndex).toBe(2);
  });

  it.each(["list", "mode", "revision"])("等待读取期间外部 %s 变化使旧计划失效", async (change) => {
    const read = deferred<SongInfo[] | null>();
    const { state, adapter, coordinator } = setup({ mode: "shuffle" });
    adapter.readOriginal = () => read.promise;
    const result = coordinator.request({ target: "repeat", isCurrent: current });
    if (change === "list") state.playList = [song("new")];
    if (change === "mode") state.mode = "repeat-once";
    if (change === "revision") {
      // 包括列表原地变动，或列表/模式 A→B→A 后引用和模式相同的情况。
      state.playList.push(song("new"));
      state.revision = 1;
    }
    read.resolve([a]);
    expect(await result).toEqual({ status: "skipped" });
    expect(adapter.commit).not.toHaveBeenCalled();
    expect(adapter.persist).not.toHaveBeenCalled();
  });

  it("await 期间 occurrence A→B→A 不会复活旧请求", async () => {
    const read = deferred<SongInfo[] | null>();
    const { adapter, coordinator } = setup({ mode: "shuffle" });
    adapter.readOriginal = () => read.promise;
    let occurrence = 1;
    const result = coordinator.request({ target: "repeat", isCurrent: () => occurrence === 1 });
    occurrence = 3;
    read.resolve([a]);
    expect(await result).toEqual({ status: "skipped" });
    expect(adapter.commit).not.toHaveBeenCalled();
  });

  it("入队前与 commit 前都检查 guard", async () => {
    const { adapter, coordinator } = setup();
    expect(await coordinator.request({ isCurrent: () => false })).toEqual({ status: "skipped" });
    expect(adapter.read).not.toHaveBeenCalled();
    let valid = true;
    adapter.shuffle = (songs) => {
      valid = false;
      return songs;
    };
    expect(await coordinator.request({ target: "shuffle", isCurrent: () => valid })).toEqual({
      status: "skipped",
    });
    expect(adapter.commit).not.toHaveBeenCalled();
  });

  it("持久化结束前保持 active，容量仅一个 active 和一个 queued，队列执行时重新计算模式", async () => {
    const save = deferred<void>();
    const { state, adapter, coordinator } = setup();
    adapter.persist = vi.fn(() => save.promise);
    const first = coordinator.request({ isCurrent: current });
    const second = coordinator.request({ isCurrent: current });
    expect(state.mode).toBe("repeat-once");
    expect(await coordinator.request({ isCurrent: current })).toEqual({ status: "busy" });
    expect(adapter.commit).toHaveBeenCalledTimes(1);
    save.resolve();
    expect(await first).toEqual({ status: "applied", mode: "repeat-once" });
    expect(await second).toEqual({ status: "applied", mode: "shuffle" });
    expect(adapter.commit).toHaveBeenCalledTimes(2);
  });

  it("排队后撤销的请求不执行，且释放容量", async () => {
    const save = deferred<void>();
    const { adapter, coordinator } = setup();
    adapter.persist = () => save.promise;
    let valid = true;
    const first = coordinator.request({ isCurrent: current });
    const second = coordinator.request({ target: "shuffle", isCurrent: () => valid });
    valid = false;
    save.resolve();
    await first;
    expect(await second).toEqual({ status: "skipped" });
    expect(await coordinator.request({ target: "repeat", isCurrent: current })).toEqual({
      status: "applied",
      mode: "repeat",
    });
  });

  it("读取失败拒绝请求但不毒化队列", async () => {
    const read = deferred<SongInfo[] | null>();
    const { adapter, coordinator } = setup({ mode: "shuffle", originalPlayList: [a] });
    adapter.readOriginal = vi
      .fn()
      .mockImplementationOnce(() => read.promise)
      .mockResolvedValue([a]);
    const first = coordinator.request({ target: "repeat", isCurrent: current });
    const rejection = expect(first).rejects.toThrow("读取失败");
    const second = coordinator.request({ target: "repeat-once", isCurrent: current });
    read.reject(new Error("读取失败"));
    await rejection;
    expect(await second).toEqual({ status: "applied", mode: "repeat-once" });
  });

  it("持久化失败明确表示已应用，后续排队请求仍执行", async () => {
    const save = deferred<void>();
    const { state, adapter, coordinator } = setup();
    adapter.persist = vi
      .fn()
      .mockImplementationOnce(() => save.promise)
      .mockResolvedValue(undefined);
    const first = coordinator.request({ isCurrent: current });
    const second = coordinator.request({ isCurrent: current });
    const error = new Error("保存失败");
    expect(state.mode).toBe("repeat-once");
    save.reject(error);
    expect(await first).toEqual({ status: "persist-failed", mode: "repeat-once", error });
    expect(await second).toEqual({ status: "applied", mode: "shuffle" });
  });

  it.each([false, true])("commit 后 guard 失效仍完成保存，不回滚或晚写：失败=%s", async (fail) => {
    const save = deferred<void>();
    const { state, adapter, coordinator } = setup();
    const snapshots: NativePlayModeSnapshot[] = [];
    adapter.persist = (snapshot) => {
      snapshots.push(snapshot);
      return save.promise;
    };
    let valid = true;
    const result = coordinator.request({ target: "shuffle", isCurrent: () => valid });
    valid = false;
    const captured = snapshots[0];
    expect(captured).toBeDefined();
    expect(captured?.originalPlayList[0]?.name).toBe("1");
    state.playList[0].name = "后续编辑";
    state.originalPlayList[0].name = "后续备份编辑";
    state.playList = [song("external")];
    state.mode = "repeat";
    state.playIndex = 0;
    let writes = 0;
    const stop = watch(state, () => writes++, { flush: "sync", deep: true });
    if (fail) save.reject(new Error("保存失败"));
    else save.resolve();
    expect((await result).status).toBe(fail ? "persist-failed" : "applied");
    expect(writes).toBe(0);
    stop();
    expect(captured?.playList[0]?.name).toBe("2");
    expect(captured?.originalPlayList[0]?.name).toBe("1");
    expect(state.mode).toBe("repeat");
    expect(keys(state.playList)).toEqual(["netease:external"]);
    expect(adapter.commit).toHaveBeenCalledTimes(1);
  });

  it("普通对象 adapter 的同步提交错误不会毒化后续队列", async () => {
    const { state, adapter, coordinator } = setup({}, false);
    const commit = adapter.commit;
    adapter.commit = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("提交失败");
      })
      .mockImplementation(commit);
    const first = coordinator.request({ target: "shuffle", isCurrent: current });
    const rejected = expect(first).rejects.toThrow("提交失败");
    const second = coordinator.request({ target: "repeat-once", isCurrent: current });
    await rejected;
    expect(await second).toEqual({ status: "applied", mode: "repeat-once" });
    expect(state.mode).toBe("repeat-once");
    expect(keys(state.playList)).toEqual(["netease:1", "qq:1", "netease:2"]);
    expect(adapter.persist).toHaveBeenCalledTimes(1);
  });

  it("最终 commit 前 guard 失效时不应用任何字段", async () => {
    const { adapter, coordinator } = setup();
    let checks = 0;
    const result = await coordinator.request({
      target: "shuffle",
      isCurrent: () => ++checks < 4,
    });
    expect(result).toEqual({ status: "skipped" });
    expect(checks).toBe(4);
    expect(adapter.commit).not.toHaveBeenCalled();
    expect(adapter.persist).not.toHaveBeenCalled();
  });

  it("等待期间模式 A→B→A、列表引用相同仍由 revision 拒绝旧计划", async () => {
    const read = deferred<SongInfo[] | null>();
    const { state, adapter, coordinator } = setup({ mode: "shuffle" });
    adapter.readOriginal = () => read.promise;
    const result = coordinator.request({ target: "repeat", isCurrent: current });
    state.mode = "repeat-once";
    state.revision = 1;
    state.mode = "shuffle";
    state.revision = 2;
    read.resolve([a]);
    expect(await result).toEqual({ status: "skipped" });
    expect(adapter.commit).not.toHaveBeenCalled();
  });
});
