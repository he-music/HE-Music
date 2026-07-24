import { defineStore } from "pinia";
import type { SongInfo } from "@/types/main.hemusic";
import { getSizeCover } from "@/utils/format";
import { isElectron } from "@/utils/env";
import { cloneDeep } from "lodash-es";
import { SongLyric } from "@/types/lyric";
import blob from "@/utils/blob";
import { artistPhotos } from "@/api/artist";
import { shuffleArray } from "@/utils/helper";

interface MusicState {
  playSong: SongInfo;
  playPlaylist: {
    id: string;
    platform: string;
    type: string;
  };
  songLyric: SongLyric;
  // 电台
  radio: {
    name: string;
    id: string;
    platform: string;
    list: SongInfo[];
    playIndex: number;
    pageIndex: number;
  };
  artistPhoto: {
    urls: string[];
    key: string;
    index: number;
  };
}

// 默认音乐数据
const defaultMusicData: SongInfo = {
  id: "",
  platform: "",
  name: "未播放歌曲",
  artists: "未知歌手",
  album: "未知专辑",
  cover: "/images/song.jpg?asset",
  duration: 0,
  mv_id: "",
  subtitle: "",
  links: [],
};

export const useMusicStore = defineStore("music", {
  state: (): MusicState => ({
    // 当前播放歌曲
    playSong: { ...defaultMusicData },
    playPlaylist: {
      id: "",
      platform: "",
      type: "",
    },
    // 当前歌曲歌词
    songLyric: {
      lrcData: [], // 普通歌词
      yrcData: [], // 逐字歌词
    },
    radio: {
      name: "", // 电台名称
      id: "", // 电台id
      platform: "", // 电台平台
      list: [], // 电台歌曲
      playIndex: 0, // 电台播放索引
      pageIndex: 1, // 电台页码
    },
    artistPhoto: {
      urls: [],
      key: "",
      index: 0,
    },
  }),
  getters: {
    isLocalSong(state): boolean {
      return !!state.playSong?.path;
    },
    // 是否具有歌词
    isHasLrc(state): boolean {
      return state.songLyric.lrcData.length > 0;
    },
    // 是否具有逐字歌词
    isHasYrc(state): boolean {
      return state.songLyric.yrcData.length > 0;
    },
    // 是否有播放器
    isHasPlayer(state): boolean {
      return !!state.playSong?.id;
    },
    // 歌曲封面
    songCover(state): string {
      return state.playSong.path ? state.playSong.cover : getSizeCover(state.playSong);
    },
    isPlayingPlaylist:
      (state) =>
      (id: string, platform: string, type: string): boolean => {
        return (
          !!state.playPlaylist.id &&
          state.playPlaylist.id === id &&
          state.playPlaylist.platform === platform &&
          state.playPlaylist.type === type
        );
      },
    // 获取歌曲封面
    getSongCover:
      (state) =>
      (size: number = 300): string => {
        return state.playSong.path ? state.playSong.cover : getSizeCover(state.playSong, size);
      },

    // 电台歌曲
    radioSong(state): SongInfo {
      return state.radio.list?.[state.radio.playIndex] || defaultMusicData;
    },
  },
  actions: {
    /** 重置音乐数据 */
    resetMusicData() {
      // 清理旧的 blob URL（如果 cover 是 blob URL）
      const oldCover = this.playSong.cover;
      const oldPath = this.playSong.path;
      if (oldCover && oldCover.startsWith("blob:") && oldPath) {
        blob.revokeBlobURL(oldPath);
      }
      this.playSong = { ...defaultMusicData };
      this.setSongLyric({ lrcData: [], yrcData: [] }, true);
      if (isElectron) {
        window.electron.ipcRenderer.send("play-song-change", undefined);
      }
    },
    /**
     * 设置/更新歌曲歌词数据
     * @param updates 部分或完整歌词数据
     * @param replace 是否覆盖（true：用提供的数据覆盖并为缺省字段置空；false：合并更新）
     */
    setSongLyric(updates: Partial<SongLyric>, replace: boolean = false) {
      if (replace) {
        this.songLyric = {
          lrcData: updates.lrcData ?? [],
          yrcData: updates.yrcData ?? [],
        };
      } else {
        this.songLyric = {
          lrcData: updates.lrcData ?? this.songLyric.lrcData,
          yrcData: updates.yrcData ?? this.songLyric.yrcData,
        };
      }
      // 更新歌词窗口数据
      if (isElectron) {
        window.electron.ipcRenderer.send(
          "play-lyric-change",
          cloneDeep({
            songId: this.playSong?.id,
            lyricLoading: false,
            lrcData: this.songLyric.lrcData ?? [],
            yrcData: this.songLyric.yrcData ?? [],
          }),
        );
      }
    },
    /**
     * 获取歌手写真
     * @param artistName 歌手名字
     */
    /**
     * 获取歌手写真
     * @param platform 平台
     * @param ids 歌手id
     * @param names 歌手名字
     */
    async fetchArtistPictures(platform: string, ids: string[], names: string[]) {
      const key = `${platform}-${ids.join(",")}-${names.join(",")}`;
      if (!names.length && !ids.length) {
        this.artistPhoto.urls = [];
        this.artistPhoto.key = "";
        this.artistPhoto.index = 0;
        return;
      }
      // 缓存命中
      if (this.artistPhoto.key === key && this.artistPhoto.urls.length > 0) {
        return;
      }

      try {
        const res = await artistPhotos(platform, ids, names);
        if (res.urls && Array.isArray(res.urls)) {
          this.artistPhoto.urls = shuffleArray(res.urls); // 随机排序
          this.artistPhoto.key = key;
          this.artistPhoto.index = 0;
        } else {
          this.artistPhoto.urls = [];
          this.artistPhoto.key = "";
          this.artistPhoto.index = 0;
        }
      } catch (e) {
        console.error("fetch artist photos failed:", e);
        this.artistPhoto.urls = [];
        this.artistPhoto.key = "";
        this.artistPhoto.index = 0;
      }
    },
  },
  // 持久化
  persist: {
    key: "music-store",
    storage: localStorage,
  },
});
