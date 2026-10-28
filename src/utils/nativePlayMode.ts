import { toRaw } from "vue";
import type { PlayModeType } from "@/types/main";
import type { SongInfo } from "@/types/main.hemusic";
import { createPlaybackListSnapshot } from "@/utils/song";

export interface NativePlayModeSnapshot {
  mode: PlayModeType;
  playList: SongInfo[];
  originalPlayList: SongInfo[];
  playIndex: number;
}

export interface NativePlayModeState extends NativePlayModeSnapshot {
  currentSong: SongInfo | null | undefined;
  /** 每次外部列表或模式变动都须更新，包括原地修改及 A→B→A；切歌无需更新。 */
  revision: string | number | symbol;
}

export interface NativePlayModeAdapter {
  read(): NativePlayModeState;
  /** 仅读取原列表，不能像 store 的 getOriginalPlayList 一样回写响应式状态。 */
  readOriginal(): Promise<SongInfo[] | null>;
  /** 纯函数；输入已经与运行时列表隔离。 */
  shuffle(songs: SongInfo[]): SongInfo[];
  /** 同步一次应用全部字段；不能启动异步运行时写入。 */
  commit(snapshot: NativePlayModeSnapshot): void;
  /** 只保存传入的独立快照，完成或失败时均不得回写运行时状态。 */
  persist(snapshot: NativePlayModeSnapshot): Promise<void>;
}

export interface NativePlayModeRequest {
  target?: PlayModeType | false;
  /** 由调用方按 occurrence 判定有效性，不能只比较当前歌曲身份。 */
  isCurrent(): boolean;
}

export type NativePlayModeResult =
  | { status: "skipped" }
  | { status: "busy" }
  | { status: "applied"; mode: PlayModeType }
  | { status: "persist-failed"; mode: PlayModeType; error: unknown };

const nextMode = (mode: PlayModeType): PlayModeType => {
  switch (mode) {
    case "repeat":
      return "repeat-once";
    case "repeat-once":
      return "shuffle";
    case "shuffle":
      return "repeat";
  }
};

const capture = (state: NativePlayModeSnapshot): NativePlayModeSnapshot => ({
  mode: state.mode,
  playList: createPlaybackListSnapshot(state.playList),
  originalPlayList: createPlaybackListSnapshot(state.originalPlayList),
  playIndex: state.playIndex,
});

type PlayModeBoundary = Pick<NativePlayModeState, "revision" | "mode" | "playList">;
const boundaryOf = (state: NativePlayModeState): PlayModeBoundary => ({
  revision: state.revision,
  mode: state.mode,
  playList: state.playList,
});
const sameBoundary = (left: PlayModeBoundary | undefined, right: PlayModeBoundary) =>
  left !== undefined &&
  left.revision === right.revision &&
  left.mode === right.mode &&
  left.playList === right.playList;

interface PendingRequest {
  request: NativePlayModeRequest;
  boundary: PlayModeBoundary | undefined;
  resolve(result: NativePlayModeResult): void;
  reject(error: unknown): void;
}

/** 仅协调模式状态；不调用播放器、认证、媒体会话或桌面桥接。 */
export const createNativePlayModeCoordinator = (adapter: NativePlayModeAdapter) => {
  let active = false;
  let queued: PendingRequest | undefined;

  const apply = async (pending: PendingRequest): Promise<NativePlayModeResult> => {
    const { request } = pending;
    if (!request.isCurrent()) return { status: "skipped" };
    const initial = { ...adapter.read() };
    if (!sameBoundary(pending.boundary, initial)) return { status: "skipped" };
    const target = request.target || nextMode(initial.mode);
    if (target === initial.mode) return { status: "skipped" };

    const snapshot = capture(initial);
    let reordered = false;
    const leavingShuffle = initial.mode === "shuffle";
    if (target === "shuffle" && initial.playList.length > 1) {
      snapshot.originalPlayList = createPlaybackListSnapshot(initial.playList);
      snapshot.playList = adapter.shuffle(snapshot.playList);
      reordered = true;
    } else if (leavingShuffle) {
      const original = await adapter.readOriginal();
      if (!request.isCurrent()) return { status: "skipped" };
      if (original?.length) {
        snapshot.playList = createPlaybackListSnapshot(original);
        reordered = true;
      }
      snapshot.originalPlayList = [];
    }

    // 异步恢复期间允许切歌，但不能将旧计划覆盖到外部更换过的列表或模式。
    const current = adapter.read();
    if (
      !request.isCurrent() ||
      current.revision !== initial.revision ||
      current.mode !== initial.mode ||
      current.playList !== initial.playList
    ) {
      return { status: "skipped" };
    }
    snapshot.mode = target;
    snapshot.playIndex = current.playIndex;
    if (reordered) {
      const index = snapshot.playList.findIndex(
        (song) =>
          song.id === current.currentSong?.id && song.platform === current.currentSong?.platform,
      );
      snapshot.playIndex = index >= 0 ? index : leavingShuffle ? 0 : current.playIndex;
    }
    // persist 与 commit 不共享对象，后续响应式编辑不会改变已捕获的保存内容。
    const persistenceSnapshot = capture(snapshot);
    if (!request.isCurrent()) return { status: "skipped" };
    const next = queued;
    const rebase = next !== undefined && sameBoundary(next.boundary, current);
    adapter.commit(snapshot);
    // 只接纳本协调器按序完成的同步提交；外部已换代的请求不能借此复活。
    if (rebase && next && queued === next) {
      next.boundary = undefined;
      try {
        const committed = adapter.read();
        if (
          committed.mode === snapshot.mode &&
          toRaw(committed.playList) === toRaw(snapshot.playList)
        ) {
          next.boundary = boundaryOf(committed);
        }
      } catch {
        // 不能确认提交后的边界时，只废弃 queued；仍等待本次 persist 真正结束。
      }
    }
    try {
      // commit 后不撤销；即使 guard 已失效，仍让这次捕获的保存正常结束。
      await adapter.persist(persistenceSnapshot);
      return { status: "applied", mode: target };
    } catch (error) {
      return { status: "persist-failed", mode: target, error };
    }
  };

  const run = async (pending: PendingRequest): Promise<void> => {
    try {
      pending.resolve(await apply(pending));
    } catch (error) {
      // 读取/同步 adapter 错误向调用方抛出，但不能毒化后续队列。
      pending.reject(error);
    } finally {
      const next = queued;
      queued = undefined;
      if (next) void run(next);
      else active = false;
    }
  };

  return {
    request(request: NativePlayModeRequest): Promise<NativePlayModeResult> {
      request = { target: request.target, isCurrent: request.isCurrent };
      if (!request.isCurrent()) return Promise.resolve({ status: "skipped" });
      if (active && queued) return Promise.resolve({ status: "busy" });
      return new Promise((resolve, reject) => {
        const pending = { request, boundary: boundaryOf(adapter.read()), resolve, reject };
        if (active) queued = pending;
        else {
          active = true;
          void run(pending);
        }
      });
    },
  };
};
