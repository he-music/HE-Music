// 为纯歌词模式重映射歌词构图；不缩放或裁切背景、光场和粒子画布。
export function adaptPVSafeLayout(path, source) {
  if (path === "components/visualizer/hanabi/hanabiSceneEntry.ts") {
    source = `import { fitPVProfile } from '../fitPVProfile';\n${source}`;
    source = source.replace(
      "profile: resolveShotProfile(shot)",
      "profile: fitPVProfile(resolveShotProfile(shot), context.theme)",
    );
    source = source.replace(
      "profile: resolveShotProfile({ kind: '' })",
      "profile: fitPVProfile(resolveShotProfile({ kind: '' }), context.theme)",
    );
  }
  if (path === "components/visualizer/lumiere/lumiereUnit.ts") {
    source = `import { fitPVProfile } from '../fitPVProfile';\n${source}`;
    source = source.replace(
      "shots: buildLumiereSceneShots(paragraph),",
      "shots: buildLumiereSceneShots(paragraph).map(shot => ({ ...shot, profile: fitPVProfile(shot.profile, options.theme) })),",
    );
  }
  if (
    path.endsWith("/createHanabiPixiRuntime.ts") ||
    path.endsWith("/createLumierePixiRuntime.ts")
  ) {
    // 同曲布局变化在 DOM 更新后同步读取尺寸、提交场景并出帧，不经过窗口拖拽的防抖队列。
    source = source.replace(
      /(swapSong\(next: (?:Hanabi|Lumiere)SongContext, signal\?: AbortSignal\): Promise<void> \{\s*if \(this.destroyed\) return Promise.resolve\(\);)/,
      `$1
        if (next.seed === this.options.song.seed) {
            this.resizeToHost(true);
            if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
            this.rebuildTimer = null;
            this.rebuildDue = false;
            this.commitSong(next, null);
            this.renderOnce();
            return Promise.resolve();
        }`,
    );
    source = source.replace("next.seed === this.options.song.seed ||", "");
  }
  return source;
}
