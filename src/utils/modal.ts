import { h } from "vue";
import type { SettingType, UpdateInfoType } from "@/types/main";
import type { ModalReactive } from "naive-ui";
import type { SongInfo, UserPlaylistInfo } from "@/types/main.hemusic";
import { isLogin } from "./auth";
import { isArray, isFunction } from "lodash-es";
import { NScrollbar } from "naive-ui";
import router from "@/router";
import { usePlatformStore } from "@/stores";
import { FeatureSupportFlag } from "@/api/platform";
import { t } from "@/i18n";

const openedModals = new Set<string>();
/**
 * 检查弹窗是否已打开，若已打开则显示提示
 * @param modalKey 弹窗唯一标识
 * @param warningMessage 已打开时的提示信息
 * @returns 是否已打开
 */
const isModalOpen = (modalKey: string, warningMessage?: string): boolean => {
  if (openedModals.has(modalKey)) {
    if (warningMessage) window.$message.warning(warningMessage);
    return true;
  }
  return false;
};

/**
 * 标记弹窗为打开状态
 */
const setModalOpen = (modalKey: string): void => {
  openedModals.add(modalKey);
};

/**
 * 标记弹窗为关闭状态
 */
const setModalClosed = (modalKey: string): void => {
  openedModals.delete(modalKey);
};

// 用户协议
export const openUserAgreement = async () => {
  const isAgree = window.localStorage.getItem("isAgree");
  if (isAgree) return;

  const { default: UserAgreement } = await import("@/components/Modal/UserAgreement.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    maskClosable: false,
    closeOnEsc: false,
    closable: false,
    style: {
      maxWidth: "70vw",
    },
    content: () => {
      return h(UserAgreement, {
        onClose: () => {
          modal.destroy();
          // 储存状态
          window.localStorage.setItem("isAgree", Date.now().toString());
        },
      });
    },
    onEsc: () => {
      window.$message.warning(t("message.agreement_required"));
    },
  });
};

let isLoginModalOpened = false;
// 用户登录
export const openUserLogin = async (showTip: boolean = false) => {
  if (showTip) window.$message.warning(t("message.login_required"));
  if (isLoginModalOpened) return;
  isLoginModalOpened = true;
  const { default: Login } = await import("@/components/Modal/Login/Login.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    maskClosable: false,
    closeOnEsc: false,
    closable: false,
    style: { width: "400px" },
    content: () => {
      return h(Login, { onClose: () => modal.destroy() });
    },
    onAfterLeave: () => {
      isLoginModalOpened = false;
    },
  });
};

// 跳转到歌手
export const openJumpArtist = async (platform: string, data: SongInfo["artists"]) => {
  const platformStore = usePlatformStore();
  if (!platformStore.isFeatureSupport(platform, FeatureSupportFlag.GetSingerInfo)) {
    return;
  }
  if (data?.length == 0) {
    return;
  }

  // 若 data 为数组且只有一个元素，则直接跳转
  if (isArray(data) && data.length === 1) {
    const id = data[0].id;
    router.push({ name: "artist", query: { id, platform } });
    return;
  }
  const { default: JumpArtist } = await import("@/components/Modal/JumpArtist.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("modal.artist_jump"),
    content: () => {
      return h(JumpArtist, { artist: data, platform, onClose: () => modal.destroy() });
    },
  });
};

// 编辑歌曲信息
export const openSongInfoEditor = async (song: SongInfo) => {
  const { default: SongInfoEditor } = await import("@/components/Modal/SongInfoEditor.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    trapFocus: false,
    // contentStyle: { padding: 0 },
    style: { width: "600px" },
    title: t("modal.song_info_edit"),
    content: () => {
      return h(SongInfoEditor, { song, onClose: () => modal.destroy() });
    },
  });
};

// 添加到歌单
export const openPlaylistAdd = async (data: SongInfo[], isLocal: boolean) => {
  if (!data.length) return window.$message.warning(t("message.please_select_song"));
  if (!isLogin() && !isLocal) return openUserLogin();
  const { default: PlaylistAdd } = await import("@/components/Modal/PlaylistAdd.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("menu.add_to_playlist"),
    content: () => {
      return h(PlaylistAdd, { data, isLocal, onClose: () => modal.destroy() });
    },
  });
};

/**
 * 开启批量操作
 * @param data 歌曲列表
 * @param isLocal 是否为本地音乐
 * @param playListId 歌单 id
 */
export const openBatchList = async (data: SongInfo[], isLocal: boolean, playListId?: string) => {
  const { default: BatchList } = await import("@/components/Modal/BatchList.vue");
  window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: {
      maxWidth: "70vw",
    },
    title: t("common.batch_operation"),
    content: () => h(BatchList, { data, isLocal, playListId }),
  });
};

// 新建歌单
export const openCreatePlaylist = async () => {
  const { default: CreatePlaylist } = await import("@/components/Modal/CreatePlaylist.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("modal.create_playlist"),
    content: () => {
      return h(CreatePlaylist, { onClose: () => modal.destroy() });
    },
  });
};

// 编辑歌单
export const openUpdatePlaylist = async (
  id: string,
  data: UserPlaylistInfo,
  func: () => Promise<void>,
) => {
  const { default: UpdatePlaylist } = await import("@/components/Modal/UpdatePlaylist.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("modal.playlist_edit"),
    content: () => {
      return h(UpdatePlaylist, {
        id,
        data,
        onSuccess: () => {
          modal.destroy();
          // 触发回调
          if (isFunction(func)) func();
        },
      });
    },
  });
};

// 下载歌曲
export const openDownloadSong = async (song: SongInfo) => {
  const { default: DownloadSong } = await import("@/components/Modal/DownloadSong.vue");
  // if (!isLogin()) return openUserLogin();
  // 是否可下载
  if (!song) return window.$message.warning(t("message.please_select_song"));
  if (song.links?.length === 0) {
    return window.$message.warning(t("message.song_not_support_download"));
  }
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("common.download_song"),
    content: () => {
      return h(DownloadSong, { song, onClose: () => modal.destroy() });
    },
  });

  return;
};

let settingModal: ModalReactive | null = null;
// 打开设置
export const openSetting = async (type: SettingType = "general", scrollTo?: string) => {
  const { default: MainSetting } = await import("@/components/Setting/MainSetting.vue");
  if (settingModal) {
    settingModal.destroy();
  }
  settingModal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    maskClosable: false,
    closeOnEsc: false,
    bordered: true,
    class: "main-setting",
    onClose: () => {
      settingModal = null;
    },
    content: () => {
      return h(MainSetting, { type, scrollTo });
    },
  });
};

// 软件更新
export const openUpdateApp = async (data: UpdateInfoType) => {
  const { default: UpdateApp } = await import("@/components/Modal/UpdateApp.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("modal.found_new_version"),
    content: () => {
      return h(UpdateApp, { data, onClose: () => modal.destroy() });
    },
  });
};

// 修改信息
export const openUpdateUserInfo = async () => {
  const { default: UpdateUserInfo } = await import("@/components/Modal/UpdateUserInfo.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    maskClosable: false,
    autoFocus: false,
    style: { width: "400px" },
    title: t("nav.modify_info"),
    content: () => {
      return h(UpdateUserInfo, { onClose: () => modal.destroy() });
    },
  });
};

// 修改密码
export const openUpdateUserPassword = async () => {
  const { default: UpdateUserPassword } = await import("@/components/Modal/UpdateUserPassword.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    maskClosable: false,
    autoFocus: false,
    style: { width: "400px" },
    title: t("modal.modify_password"),
    content: () => {
      return h(UpdateUserPassword, { onClose: () => modal.destroy() });
    },
  });
};

// 设备管理
export const openDeviceManager = async () => {
  const { default: DeviceManager } = await import("@/components/Modal/Device/DeviceManager.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    maskClosable: true,
    autoFocus: false,
    style: { width: "480px" },
    title: t("device.title"),
    content: () => {
      return h(DeviceManager, { onClose: () => modal.destroy() });
    },
  });
};

// 歌词排除内容
export const openParseSourceUrl = async () => {
  const { default: ParseSourceUrl } = await import("@/components/Modal/ParseSourceUrl.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("nav.parse_source_url"),
    content: () => {
      return h(ParseSourceUrl, { onClose: () => modal.destroy() });
    },
  });
};

export const openCaptcha = async (scene: number, meta: string): Promise<boolean> => {
  const { default: Captcha } = await import("@/components/Modal/Captcha.vue");
  return new Promise((resolve) => {
    const modal = window.$modal.create({
      preset: "card",
      transformOrigin: "center",
      autoFocus: false,
      style: { width: "375px" },
      title: t("modal.security_verify"),
      maskClosable: false,
      content: () => {
        return h(Captcha, {
          scene,
          meta,
          onSuccess: () => {
            modal.destroy();
            resolve(true); // 验证成功
          },
        });
      },
      onClose: () => {
        resolve(false); // 关闭弹窗，验证失败
      },
    });
  });
};

/** 打开播放速度弹窗 */
export const openChangeRate = async () => {
  const { default: ChangeRate } = await import("@/components/Modal/ChangeRate.vue");
  window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("common.play_rate"),
    content: () => {
      return h(ChangeRate);
    },
  });
};

/** 打开自动关闭弹窗 */
export const openAutoClose = async () => {
  const { default: AutoClose } = await import("@/components/Modal/AutoClose.vue");
  window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("common.auto_close"),
    content: () => {
      return h(AutoClose);
    },
  });
};

/** 打开均衡器弹窗 */
export const openEqualizer = async () => {
  const { default: Equalizer } = await import("@/components/Modal/Equalizer.vue");
  window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "620px" },
    title: t("common.equalizer"),
    content: () => {
      return h(Equalizer);
    },
  });
};

/**
 * 打开简介弹窗
 * @param content 简介内容
 */
export const openDescModal = (content: string) => {
  window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("common.description"),
    content: () => {
      return h(
        NScrollbar,
        { style: { maxHeight: "400px" } },
        {
          default: () =>
            h("div", { style: { whiteSpace: "pre-wrap" } }, { default: () => content }),
        },
      );
    },
  });
};

/** 打开复制歌词弹窗 */
export const openCopyLyrics = async () => {
  const { default: CopyLyrics } = await import("@/components/Modal/CopyLyrics.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    trapFocus: false,
    style: { width: "500px" },
    title: t("common.copy_lyrics"),
    content: () => {
      return h(CopyLyrics, {
        onClose: () => modal.destroy(),
      });
    },
  });
};

/** 打开主题配置弹窗 */
export const openThemeConfig = async () => {
  if (isModalOpen("themeConfig", "主题配置已打开")) return;
  setModalOpen("themeConfig");
  const { default: ThemeConfig } = await import("@/components/Modal/Setting/ThemeConfig.vue");
  window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    draggable: true,
    style: { width: "500px" },
    title: t("setting.general.theme_config"),
    size: "small",
    content: () => {
      return h(ThemeConfig);
    },
    onAfterLeave: () => {
      setModalClosed("themeConfig");
    },
  });
};

/** 打开本地音乐目录管理弹窗 */
export const openLocalMusicDirectoryModal = async () => {
  const { default: LocalMusicDirectory } = await import(
    "@/components/Modal/Setting/LocalMusicDirectory.vue"
  );
  window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    maskClosable: false,
    closeOnEsc: false,
    style: { width: "600px" },
    title: t("local.manage_local_music_folder"),
    content: () => {
      return h(LocalMusicDirectory);
    },
  });
};

/** 打开字体管理弹窗 */
export const openFontManager = async () => {
  const { default: FontManager } = await import("@/components/Modal/Setting/FontManager.vue");
  window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "700px" },
    title: t("setting.font_setting"),
    content: () => {
      return h(FontManager);
    },
  });
};

/** 打开歌词排除弹窗 */
export const openExcludeLyric = async () => {
  const { default: ExcludeLyrics } = await import("@/components/Modal/Setting/ExcludeLyrics.vue");
  const modal = window.$modal.create({
    preset: "card",
    transformOrigin: "center",
    autoFocus: false,
    style: { width: "600px" },
    title: t("setting.lyrics.lyrics_exclude"),
    content: () => {
      return h(ExcludeLyrics, {
        onClose: () => modal.destroy(),
      });
    },
  });
};
