import { useDataStore, useSettingStore, useShortcutStore, useStatusStore } from "@/stores";
import { useEventListener } from "@vueuse/core";
import { platform } from "@/platform";
import { shortcutSession } from "@/platform/shortcutSession";
import packageJson from "@/../package.json";
import { usePlayer } from "@/utils/player";
import log from "./log";
import { useI18n } from "vue-i18n";

// 应用初始化时需要执行的操作
const init = async () => {
  // init pinia-data
  const dataStore = useDataStore();
  const statusStore = useStatusStore();
  const settingStore = useSettingStore();
  const { locale } = useI18n();
  // init pinia-data
  const player = usePlayer();

  locale.value = settingStore.language;

  printVersion();

  // 事件监听
  initEventListener();
  // 加载数据
  await dataStore.loadData();
  // 初始化播放器
  player.initPlayer(
    settingStore.autoPlay,
    settingStore.memoryLastSeek ? statusStore.currentTime : 0,
  );

  // 初始化自动关闭定时器
  if (statusStore.autoClose.enable) {
    player.startAutoCloseTimer(statusStore.autoClose.time, statusStore.autoClose.remainTime);
  }
};

// 事件监听
const initEventListener = () => {
  // 键盘事件
  useEventListener(window, "keydown", keyDownEvent);
};

const keyDownEvent = (event: KeyboardEvent) => {
  // 忽略长按连发
  if (event.repeat) return;
  const target = event.target as HTMLElement | null;
  // 排除输入框与可编辑元素
  if (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable ||
      target.closest("input, textarea, [contenteditable='true']"))
  ) {
    return;
  }
  const nativeChord = [
    event.metaKey && "Super",
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.code,
  ]
    .filter(Boolean)
    .join("+");
  if (shortcutSession(useShortcutStore())?.owns(nativeChord)) return;
  const player = usePlayer();
  const shortcutStore = useShortcutStore();
  const statusStore = useStatusStore();

  // 获取按键信息
  const key = event.code;
  const isCtrl = event.ctrlKey || event.metaKey;
  const isShift = event.shiftKey;
  const isAlt = event.altKey;

  // 循环注册快捷键
  for (const shortcutKey in shortcutStore.shortcutList) {
    const shortcut =
      shortcutStore.shortcutList[shortcutKey as keyof typeof shortcutStore.shortcutList];
    if (!shortcut?.shortcut) continue;
    const shortcutParts = shortcut.shortcut.split("+");
    let match = true;
    const hasCmdOrCtrl = shortcutParts.includes("CmdOrCtrl");
    const hasShift = shortcutParts.includes("Shift");
    const hasAlt = shortcutParts.includes("Alt");
    if (hasCmdOrCtrl && !isCtrl) match = false;
    if (hasShift && !isShift) match = false;
    if (hasAlt && !isAlt) match = false;
    if (!hasCmdOrCtrl && !hasShift && !hasAlt) {
      if (isCtrl || isShift || isAlt) match = false;
    }
    const mainKey = shortcutParts.find(
      (part: string) => part !== "CmdOrCtrl" && part !== "Shift" && part !== "Alt",
    );
    if (mainKey !== key) match = false;
    if (match) {
      event.preventDefault();
      event.stopPropagation();
      switch (shortcutKey) {
        case "playOrPause":
          player.playOrPause();
          break;
        case "playPrev":
          player.nextOrPrev("prev");
          break;
        case "playNext":
          player.nextOrPrev("next");
          break;
        case "volumeUp":
          player.setVolume("up");
          break;
        case "volumeDown":
          player.setVolume("down");
          break;
        case "toggleDesktopLyric":
          if (platform.capabilities.desktopLyrics) player.toggleDesktopLyric();
          break;
        case "openPlayer":
          statusStore.showFullPlayer = true;
          break;
        case "closePlayer":
          if (statusStore.showFullPlayer) {
            statusStore.showFullPlayer = false;
          }
          break;
        case "openPlayList":
          statusStore.playListShow = !statusStore.playListShow;
          break;
        default:
          break;
      }
      break;
    }
  }
};

// 版本输出
const printVersion = async () => {
  log.success(`🚀 ${packageJson.version}`, packageJson.productName);
  log.info(`👤 imsyy`, `https://github.com/imsyy/SPlayer`);
  log.info(`👤 ${packageJson.author}`, packageJson.github);
};

export default init;
