import { defineStore } from "pinia";
import { keywords, regexes } from "@/assets/data/exclude";
import { ThemeColorType } from "@/types/color";
import { FontStyleSelection } from "@/types/global";

interface SettingState {
  /** 明暗模式 */
  themeMode: "light" | "dark" | "auto";
  themeColorType: ThemeColorType;
  themeCustomColor: string;
  themeGlobalColor: boolean;
  themeFollowCover: boolean;
  /** 主题变体 */
  themeVariant: "primary" | "secondary" | "tertiary" | "neutral" | "neutralVariant" | "error";
  globalFont: "default" | FontStyleSelection;
  lyricFont: "follow" | FontStyleSelection;
  /** 日语歌词字体 */
  japaneseLyricFont: "follow" | FontStyleSelection;
  /** 英语歌词字体 */
  englishLyricFont: "follow" | FontStyleSelection;
  /** 韩语歌词字体 */
  koreanLyricFont: "follow" | FontStyleSelection;
  showCloseAppTip: boolean;
  closeAppMethod: "exit" | "hide";
  showTaskbarProgress: boolean;
  useOnlineService: boolean;
  checkUpdateOnStart: boolean;
  hideVipTag: boolean;
  lyricFontSize: number;
  lyricTranFontSize: number;
  lyricRomaFontSize: number;
  lyricFontBold: boolean;
  showYrc: boolean;
  showYrcAnimation: boolean;
  showYrcLongEffect: boolean;
  showTran: boolean;
  showRoma: boolean;
  lyricsPosition: "flex-start" | "center" | "flex-end";
  lyricsScrollOffset: number;
  downloadPath: string;
  /** 音乐命名格式 */
  fileNameFormat: "title" | "artist-title" | "title-artist";
  /** 文件智能分类 */
  folderStrategy: "none" | "artist" | "artist-album";
  downloadMeta: boolean;
  downloadCover: boolean;
  downloadLyric: boolean;
  downloadLyricTran: boolean;
  downloadLyricRoma: boolean;
  saveMetaFile: boolean;
  proxyProtocol: "off" | "http" | "https";
  proxyServe: string;
  proxyPort: number;
  songLevel: string;
  playDevice: "default" | string;
  autoPlay: boolean;
  songVolumeFade: boolean;
  songVolumeFadeTime: number;
  useSongUnlock: boolean;
  countDownShow: boolean;
  barLyricShow: boolean;
  /** 播放器元素自动隐藏 */
  autoHidePlayerMeta: boolean;
  playerType: "cover" | "record" | "fullscreen";
  playerBackgroundType: "none" | "animation" | "blur" | "color" | "artist-photo";
  /** 背景动画帧率 */
  playerBackgroundFps: number;
  /** 背景动画流动速度 */
  playerBackgroundFlowSpeed: number;
  playerMainColorType: "default" | "follow-cover" | "follow-theme" | "custom"; // 播放器主题色类型
  playerMainColorCustom: string;
  memoryLastSeek: boolean;
  showPlaylistCount: boolean;
  showSpectrums: boolean;
  smtcOpen: boolean;
  lyricsBlur: boolean;
  lrcMousePause: boolean;
  showSearchHistory: boolean;
  useAMLyrics: boolean;
  useAMSpring: boolean;
  AMHidePassedLines: boolean;
  AMWordFadeWidth: number;
  menuShowCover: boolean;
  preventSleep: boolean;
  localFilesPath: string[];
  localSeparators: string[];
  showLocalCover: boolean;
  routeAnimation: "none" | "fade" | "zoom" | "slide" | "up";
  playerExpandAnimation: "up" | "flow";
  useRealIP: boolean;
  realIP: string;
  fullPlayerCache: boolean;
  useKeepAlive: boolean;
  enableOnlineLyricsExclude: boolean;
  enableTTMLExclude: boolean;
  enableLocalLyricsExclude: boolean;
  lyricsExcludeKeywords: string[];
  lyricsExcludeRegexes: string[];
  showDefaultLocalPath: boolean;
  /** 展示当前歌曲歌词状态信息 */
  showPlayMeta: boolean;
  enableTTMLLyrics: boolean;
  language: "zh-CN" | "en";
  /** 自定义协议注册 **/
  registryProtocols: string[];
}

export const useSettingStore = defineStore("setting", {
  state: (): SettingState => ({
    // 个性化
    themeMode: "auto", // 明暗模式
    themeColorType: "default", // 主题类别
    themeCustomColor: "#fe7971", // 主题自定义颜色
    themeFollowCover: false, // 主题跟随歌曲封面
    themeGlobalColor: false, // 全局着色
    themeVariant: "secondary",
    globalFont: "default", // 全局字体
    lyricFont: "follow", // 歌词区域字体
    japaneseLyricFont: "follow",
    englishLyricFont: "follow",
    koreanLyricFont: "follow",
    hideVipTag: false, // 隐藏 VIP 标签
    showSearchHistory: true, // 显示搜索历史
    menuShowCover: true, // 菜单显示封面
    routeAnimation: "slide", // 路由动画
    playerExpandAnimation: "up", // 播放器展开动画
    language: "zh-CN", // 语言
    // 系统
    useOnlineService: true, // 是否使用在线服务
    showCloseAppTip: true, // 显示关闭应用提示
    closeAppMethod: "hide", // 关闭方式
    showTaskbarProgress: false, // 显示任务栏进度
    checkUpdateOnStart: false, // 启动时检查更新
    preventSleep: false, // 是否禁止休眠
    fullPlayerCache: false, // 全屏播放器缓存
    useKeepAlive: true, // 使用 keep-alive
    // 播放
    songLevel: "320mp3", // 音质
    playDevice: "default", // 播放设备
    autoPlay: false, // 自动播放
    songVolumeFade: true, // 渐入渐出
    songVolumeFadeTime: 300, // 渐入渐出时间
    useSongUnlock: true, // 是否使用解灰
    countDownShow: true, // 显示倒计时
    barLyricShow: true, // 显示歌词条
    autoHidePlayerMeta: true, // 播放器元素自动隐藏
    playerType: "cover", // 播放器类型
    playerBackgroundType: "blur", // 背景类型
    playerBackgroundFps: 30,
    playerBackgroundFlowSpeed: 4,
    playerMainColorType: "follow-cover", // 播放器主题色类型
    playerMainColorCustom: "#EFEFEF", // 播放器主题色
    memoryLastSeek: true, // 记忆最后进度
    showPlaylistCount: true, // 显示播放列表数量
    showSpectrums: true, // 是否显示音乐频谱
    smtcOpen: true, // 是否开启 SMTC
    // 歌词
    lyricFontSize: 46, // 歌词大小
    lyricTranFontSize: 22, // 歌词翻译大小
    lyricRomaFontSize: 18, // 歌词音译大小
    lyricFontBold: true, // 歌词字体加粗
    useAMLyrics: false, // 是否使用 AM 歌词
    useAMSpring: false, // 是否使用 AM 歌词弹簧效果
    AMHidePassedLines: false /** 隐藏已播放歌词 */,
    AMWordFadeWidth: 0.5 /** 文字动画的渐变宽度 */,
    showYrc: true, // 显示逐字歌词
    showYrcAnimation: true, // 显示逐字歌词动画
    showYrcLongEffect: true,
    showTran: true, // 显示歌词翻译
    showRoma: true, // 显示歌词音译
    lyricsPosition: "flex-start", // 歌词位置
    lyricsScrollOffset: 0.25, // 歌词滚动偏移量
    lyricsBlur: false, // 歌词模糊
    lrcMousePause: false, // 鼠标悬停暂停
    enableOnlineLyricsExclude: true, // 在线歌词排除
    enableTTMLExclude: false, // 歌词排除 TTML
    enableLocalLyricsExclude: false,
    lyricsExcludeKeywords: keywords, // 歌词排除关键字
    lyricsExcludeRegexes: regexes, // 歌词排除正则表达式
    enableTTMLLyrics: true, // 启用 TTML 歌词
    // 本地
    localFilesPath: [],
    showDefaultLocalPath: true, // 显示默认本地路径
    localSeparators: ["/", "&"],
    showLocalCover: true,
    // 下载
    downloadPath: "", // 默认下载路径
    fileNameFormat: "title-artist",
    folderStrategy: "none",
    downloadMeta: true, // 同时下载元信息
    downloadCover: true, // 同时下载封面
    downloadLyric: true, // 同时下载歌词
    downloadLyricTran: false, // 下载歌词翻译
    downloadLyricRoma: false, // 下载歌词音译
    saveMetaFile: false, // 保留为独立文件
    // 网络
    proxyProtocol: "off", // 代理协议
    proxyServe: "127.0.0.1", // 代理地址
    proxyPort: 80, // 代理端口
    useRealIP: false, // 是否使用真实 IP
    realIP: "116.25.146.177", // 真实IP地址
    showPlayMeta: false,
    registryProtocols: [],
  }),
  getters: {
    /**
     * 获取淡入淡出时间
     * @returns 淡入淡出时间
     */
    getFadeTime(state): number {
      return state.songVolumeFade ? state.songVolumeFadeTime : 0;
    },
  },
  actions: {
    // 更换明暗模式
    setThemeMode(mode?: "auto" | "light" | "dark") {
      // 若未传入
      if (mode === undefined) {
        if (this.themeMode === "auto") {
          this.themeMode = "light";
        } else if (this.themeMode === "light") {
          this.themeMode = "dark";
        } else {
          this.themeMode = "auto";
        }
      } else {
        this.themeMode = mode;
      }
    },
  },
  // 持久化
  persist: {
    key: "setting-store",
    storage: localStorage,
  },
});
