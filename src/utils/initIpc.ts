import { isElectron } from "./env";
import { openSetting, openUpdateApp } from "./modal";
import { useMusicStore, useDataStore, useStatusStore } from "@/stores";
import { usePlayer } from "./player";
import { toLikeSong } from "./auth";
import { t } from "@/i18n";
import { cloneDeep } from "lodash-es";
import songManager from "./songManager";
import { SettingType } from "@/types/main";
import { handleProtocolUrl } from "@/utils/protocol";

// 关闭更新状态
const closeUpdateStatus = () => {
  const statusStore = useStatusStore();
  statusStore.updateCheck = false;
};
// 全局 IPC 事件
const initIpc = () => {
  try {
    if (!isElectron) return;
    const player = usePlayer();
    // 播放
    window.electron.ipcRenderer.on("play", () => player.play());
    // 暂停
    window.electron.ipcRenderer.on("pause", () => player.pause());
    // 播放或暂停
    window.electron.ipcRenderer.on("playOrPause", () => player.playOrPause());
    // 上一曲
    window.electron.ipcRenderer.on("playPrev", () => player.nextOrPrev("prev"));
    // 下一曲
    window.electron.ipcRenderer.on("playNext", () => player.nextOrPrev("next"));
    // 音量加
    window.electron.ipcRenderer.on("volumeUp", () => player.setVolume("up"));
    // 音量减
    window.electron.ipcRenderer.on("volumeDown", () => player.setVolume("down"));
    // 播放模式切换
    window.electron.ipcRenderer.on("changeMode", (_, mode) => player.togglePlayMode(mode));
    // 喜欢歌曲
    window.electron.ipcRenderer.on("toggleLikeSong", async () => {
      const dataStore = useDataStore();
      const musicStore = useMusicStore();
      await toLikeSong(musicStore.playSong, !dataStore.isLikeSong(musicStore.playSong));
    });
    // 开启设置
    window.electron.ipcRenderer.on("openSetting", (_, type: SettingType, scrollTo?: string) =>
      openSetting(type, scrollTo),
    );
    // 桌面歌词开关
    window.electron.ipcRenderer.on("toggleDesktopLyric", () => player.toggleDesktopLyric());
    window.electron.ipcRenderer.on("closeDesktopLyric", () => player.setDesktopLyricShow(false));
    // 无更新
    window.electron.ipcRenderer.on("update-not-available", () => {
      closeUpdateStatus();
      window.$message.success(t("message.already_latest_version"));
    });
    // 请求歌词数据
    window.electron.ipcRenderer.on("request-desktop-lyric-data", () => {
      const musicStore = useMusicStore();
      const statusStore = useStatusStore();
      if (player) {
        const { name, artist } = songManager.getPlayerInfoObj() || {};
        window.electron.ipcRenderer.send(
          "update-desktop-lyric-data",
          cloneDeep({
            playStatus: statusStore.playStatus,
            playName: name,
            artistName: artist,
            currentTime: statusStore.currentTime,
            songId: musicStore.playSong?.id,
            songOffset: statusStore.getSongOffset(musicStore.playSong),
            lrcData: musicStore.songLyric.lrcData ?? [],
            yrcData: musicStore.songLyric.yrcData ?? [],
            lyricIndex: statusStore.lyricIndex,
          }),
        );
      }
    });
    // 有更新
    window.electron.ipcRenderer.on("update-available", (_, info) => {
      closeUpdateStatus();
      openUpdateApp(info);
    });
    // 更新错误
    window.electron.ipcRenderer.on("update-error", (_, error) => {
      console.error("Error updating:", error);
      closeUpdateStatus();
      window.$message.error(t("message.update_error"));
    });
    // 协议数据
    window.electron.ipcRenderer.on("protocol-url", (_, url) => {
      console.log("📡 Received protocol url:", url);
      handleProtocolUrl(url);
    });
  } catch (error) {
    console.log(error);
  }
};

export default initIpc;
