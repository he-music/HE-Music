import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { songLyric } from "@/api/song";
import { type SongLyric } from "@/types/lyric";
import { type LyricLine } from "@applemusic-like-lyrics/lyric";
import { isElectron } from "./env";
import { isWordLyric, parseLineLyric, parseWordLyric, splitLocalLyrics } from "@/utils/lyric";

class LyricManager {
  /**
   * 重置当前歌曲的歌词数据
   * 包括清空歌词数据、重置歌词索引、关闭 TTMLL 歌词等
   */
  private resetSongLyric() {
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 重置歌词数据
    musicStore.setSongLyric({}, true);
    // 重置歌词索引
    statusStore.lyricIndex = -1;
    statusStore.lyricLoading = false;
  }
  /**
   * 处理在线歌词
   * @param id 歌曲 ID
   * @param platform 平台
   * @returns 歌词数据
   */
  private async handleOnlineLyric(id: string, platform: string): Promise<SongLyric> {
    // 最终结果
    const result: SongLyric = { lrcData: [], yrcData: [] };
    // 处理 LRC 歌词
    const data = await songLyric(id, platform);
    if (isWordLyric(data.lyric)) {
      result.yrcData = parseWordLyric(data).line;
    } else {
      result.lrcData = parseLineLyric(data).line;
    }
    return result;
  }
  /**
   * 处理本地歌词
   * @param path 本地歌词路径
   * @returns 歌词数据
   */
  private async handleLocalLyric(path: string): Promise<SongLyric> {
    console.log("path", path);
    try {
      const lyric = await window.electron.ipcRenderer.invoke("get-music-lyric", path);
      if (!lyric) return { lrcData: [], yrcData: [] };

      const splitLyric = splitLocalLyrics(lyric);
      console.log("splitLyric", splitLyric);
      // 解析
      const lrcLines: LyricLine[] = parseLineLyric(splitLyric).line;

      return { lrcData: lrcLines, yrcData: [] };
    } catch {
      return { lrcData: [], yrcData: [] };
    }
  }
  /**
   * 处理歌词排除
   * @param lyricData 歌词数据
   * @returns 处理后的歌词数据
   */
  private handleLyricExclude(lyricData: SongLyric): SongLyric {
    const settingStore = useSettingStore();
    const { lyricsExcludeKeywords, lyricsExcludeRegexes } = settingStore;
    // 处理正则表达式
    const regexes = (lyricsExcludeRegexes || []).map((r: string) => new RegExp(r));
    /**
     * 判断歌词是否被排除
     * @param line 歌词行
     * @returns 是否被排除
     */
    const isExcluded = (line: LyricLine) => {
      const content = (line?.words || [])
        .map((w) => String(w.word || ""))
        .join("")
        .trim();
      if (!content) return true;
      return (
        (lyricsExcludeKeywords || []).some((k: string) => content.includes(k)) ||
        regexes.some((re) => re.test(content))
      );
    };
    /**
     * 过滤排除的歌词行
     * @param lines 歌词行数组
     * @returns 过滤后的歌词行数组
     */
    const filterLines = (lines: LyricLine[]) => (lines || []).filter((l) => !isExcluded(l));
    return {
      lrcData: filterLines(lyricData.lrcData || []),
      yrcData: filterLines(lyricData.yrcData || []),
    };
  }
  /**
   * 设置最终歌词
   * @param lyricData 歌词数据
   */
  private setFinalLyric(lyricData: SongLyric) {
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 如果只有逐字歌词
    if (lyricData.lrcData.length === 0 && lyricData.yrcData.length > 0) {
      // 构成普通歌词
      lyricData.lrcData = lyricData.yrcData.map((line) => ({
        ...line,
        words: [
          {
            word: line.words?.map((w) => w.word)?.join("") || "",
            startTime: line.startTime || 0,
            endTime: line.endTime || 0,
            romanWord: line.words?.map((w) => w.romanWord)?.join("") || "",
          },
        ],
      }));
    }
    // 设置歌词
    musicStore.setSongLyric(lyricData, true);
    // 结束加载状态
    statusStore.lyricLoading = false;
  }
  /**
   * 处理歌词
   * @param id 歌曲 ID
   * @param platform 平台
   * @param path 本地歌词路径（可选）
   */
  public async handleLyric(id: string, platform: string, path?: string) {
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    try {
      // 歌词加载状态
      statusStore.lyricLoading = true;
      // 通知桌面歌词
      if (isElectron) {
        window.electron.ipcRenderer.send("update-desktop-lyric-data", {
          lyricLoading: true,
        });
      }
      let lyricData;
      if (path) {
        lyricData = await this.handleLocalLyric(path);
        // 排除本地歌词内容
        if (settingStore.enableLocalLyricsExclude) {
          lyricData = this.handleLyricExclude(lyricData);
        }
      } else {
        lyricData = await this.handleOnlineLyric(id, platform);
        if (settingStore.enableOnlineLyricsExclude) {
          // 排除内容
          lyricData = this.handleLyricExclude(lyricData);
        }
      }
      console.log("最终歌词数据", lyricData);
      this.setFinalLyric(lyricData);
    } catch (error) {
      console.error("❌ 处理歌词失败:", error);
      // 重置歌词
      this.resetSongLyric();
    }
  }
  /**
   * 计算歌词索引
   * - 普通歌词(LRC)：沿用当前按开始时间定位的算法
   * - 逐字歌词(YRC)：当播放时间位于某句 [time, endTime) 区间内时，索引为该句；
   *   若下一句开始时间落在上一句区间（对唱重叠），仍保持上一句索引，直到上一句结束。
   */
  public calculateLyricIndex(currentTime: number): number {
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    // 应用实时偏移（按歌曲 id 记忆） + 0.3s（解决对唱时歌词延迟问题）
    const offset = statusStore.getSongOffset(musicStore.playSong);
    const playSeek = currentTime + offset + 300;
    // 选择歌词类型
    const useYrc = !!(settingStore.showYrc && musicStore.songLyric.yrcData.length);
    const lyrics = useYrc ? musicStore.songLyric.yrcData : musicStore.songLyric.lrcData;
    // 无歌词时
    if (!lyrics || !lyrics.length) return -1;
    // 获取开始时间和结束时间
    const getStart = (v: LyricLine) => v.startTime || 0;
    const getEnd = (v: LyricLine) => v.endTime ?? Infinity;
    // 普通歌词：保持原有计算方式
    if (!useYrc) {
      const idx = lyrics.findIndex((v) => getStart(v) >= playSeek);
      return idx === -1 ? lyrics.length - 1 : idx - 1;
    }
    // TTML / YRC（支持对唱重叠）
    // 在第一句之前
    if (playSeek < getStart(lyrics[0])) return -1;
    // 计算在播放进度下处于激活区间的句子集合 activeIndices（[time, endTime)）
    const activeIndices: number[] = [];
    for (let i = 0; i < lyrics.length; i++) {
      const start = getStart(lyrics[i]);
      const end = getEnd(lyrics[i]);
      if (playSeek >= start && playSeek < end) {
        activeIndices.push(i);
      }
    }
    // 不在任何区间 → 找最近的上一句
    if (activeIndices.length === 0) {
      const next = lyrics.findIndex((v) => getStart(v) > playSeek);
      return next === -1 ? lyrics.length - 1 : next - 1;
    }
    // 1 句激活 → 直接返回
    if (activeIndices.length === 1) return activeIndices[0];
    // 多句激活（对唱）
    const keepCount = activeIndices.length >= 3 ? 3 : 2;
    const concurrent = activeIndices.slice(-keepCount);
    return concurrent[0]; // 保持上一句（重叠时不跳）
  }
}

export default new LyricManager();
