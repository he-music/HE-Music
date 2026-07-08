import type { UpdateLogType } from "@/types/main";
import { NTooltip, SelectOption } from "naive-ui";
import { h, VNode } from "vue";
import { useClipboard } from "@vueuse/core";
import { getCacheData } from "./cache";
import { updateLog } from "@/api/other";
import { isEmpty } from "lodash-es";
import { convertToLocalTime } from "./time";
import { useSettingStore } from "@/stores";
import { marked } from "marked";
import SvgIcon from "@/components/Global/SvgIcon.vue";
import type { SongInfo } from "@/types/main.hemusic";
import { t } from "@/i18n";
import { isElectron } from "@/utils/env";
import Fuse from "fuse.js";
import { API_URL } from "@/utils/request";

type AnyObject = { [key: string]: any };

// 必要数据
let imageBlobURL: string = "";

// 链接跳转
export const openLink = (url: string, target: "_self" | "_blank" = "_blank") => {
  window.open(url, target);
};

// 图标渲染
export const renderIcon = (
  iconName: string,
  option: {
    size?: number;
    style?: AnyObject;
  } = {},
) => {
  const { size, style } = option;
  return () => {
    return h(SvgIcon, { name: iconName, size, style });
  };
};

/**
 * 延时函数
 * @param ms 延时时间（毫秒）
 */
export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// 选项渲染
export const renderOption = ({ node, option }: { node: VNode; option: SelectOption }) =>
  h(
    NTooltip,
    { placement: "left" },
    {
      trigger: () => node,
      default: () => option.label,
    },
  );

// 模糊搜索
export const fuzzySearch = (keyword: string, data: SongInfo[]): SongInfo[] => {
  try {
    if (!keyword || !data || !Array.isArray(data)) return [];

    const fuse = new Fuse(data, {
      // 针对歌曲可读字段进行索引
      keys: [
        { name: "name", weight: 0.5 },
        { name: "id", weight: 0.2 },
        { name: "artists", weight: 0.15 },
        { name: "artists.name", weight: 0.15 },
        { name: "album", weight: 0.1 },
        { name: "album.name", weight: 0.1 },
      ],
      threshold: 0.35, // 0 精确匹配 ~ 1 完全模糊
      ignoreLocation: true, // 不要求关键词位置接近
    });

    return fuse.search(keyword).map((result) => result.item);
  } catch (error) {
    console.error("模糊搜索出现错误：", error);
    return [];
  }
};

/**
 * 将 32 位 ARGB 颜色值转换为 24 位 RGB 颜色值
 *
 * @param {number} x - 32位ARGB颜色值
 * @returns {number[]} - 包含红色、绿色和蓝色分量的24位RGB颜色值数组（0-255）
 */
export const argbToRgb = (x: number): number[] => {
  // 提取红色、绿色和蓝色分量
  const r = (x >> 16) & 0xff;
  const g = (x >> 8) & 0xff;
  const b = x & 0xff;
  // 返回24位RGB颜色值数组
  return [r, g, b];
};

// 封面加载完成
export const coverLoaded = (e: Event) => {
  const target = e.target as HTMLElement | null;
  if (target && target.nodeType === Node.ELEMENT_NODE) {
    target.style.opacity = "1";
  }
};

// 数字处理
export const formatNumber = (num: number): string => {
  if (num < 10000) {
    return num.toString();
  } else if (num < 100000000) {
    return `${(num / 10000).toFixed(1)}万`;
  } else {
    return `${(num / 100000000).toFixed(1)}亿`;
  }
};

// 文件大小处理
export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  } else {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
};

// 将图片链接转为 BlobUrl
export const convertImageUrlToBlobUrl = async (imageUrl: string) => {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error("Network response was not ok");
  }
  // 将响应数据转换为 Blob 对象
  const blob = await response.blob();
  // 撤销之前生成的对象 URL
  if (imageBlobURL) URL.revokeObjectURL(imageBlobURL);
  // 生成对象 URL
  imageBlobURL = URL.createObjectURL(blob);
  return imageBlobURL;
};

// 复制文本
export const copyData = async (text: any, message?: string) => {
  const { copy, copied, isSupported } = useClipboard({ legacy: true });
  if (!isSupported.value) {
    window.$message.error(t("message.copy_not_support"));
    return;
  }
  // 开始复制
  try {
    if (!text) return;
    text = typeof text === "string" ? text.trim() : JSON.stringify(text, null, 2);
    await copy(text);
    if (copied.value) {
      window.$message.success(message ?? t("message.copy_success"));
    } else {
      window.$message.error(t("message.copy_fail"));
    }
  } catch (error) {
    window.$message.error(t("message.copy_fail"));
    console.error("复制出错：", error);
  }
};

// 获取剪贴板内容
export const getClipboardData = async (): Promise<string | null> => {
  try {
    const text = await navigator.clipboard.readText();
    return text;
  } catch (error) {
    console.error("Failed to read clipboard content:", error);
    return null;
  }
};

/**
 * 格式化为 Electron 快捷键
 * @param shortcut 快捷键
 * @returns Accelerator
 */
export const formatForGlobalShortcut = (shortcut: string): string => {
  return shortcut
    .split("+")
    .map((part) => {
      // 字母
      if (part.startsWith("Key")) {
        return part.replace("Key", "");
      }
      // 数字
      if (part.startsWith("Digit")) {
        return part.replace("Digit", "num");
      }
      if (part.startsWith("Numpad")) {
        return part.replace("Numpad", "num");
      }
      // 方向键
      if (part.startsWith("Arrow")) {
        return part.replace("Arrow", "");
      }
      return part;
    })
    .join("+");
};

// 获取更新日志
export const getUpdateLog = async (): Promise<UpdateLogType[]> => {
  const result = await getCacheData(updateLog, { key: "updateLog", time: 10 });
  console.log(result);
  if (!result || isEmpty(result)) return [];
  const updateLogs = await Promise.all(
    result.map(async (v: any) => ({
      version: v.tag_name,
      changelog: v.body ? await marked(v.body) : "",
      time: convertToLocalTime(v.published_at),
      url: v.html_url,
      prerelease: v.prerelease,
    })),
  );
  return updateLogs;
};

/**
 * 更改本地目录
 * @param delIndex 删除文件夹路径的索引
 */
export const changeLocalPath = async (delIndex?: number) => {
  try {
    if (!isElectron) return;
    const settingStore = useSettingStore();
    if (typeof delIndex === "number" && delIndex >= 0) {
      settingStore.localFilesPath.splice(delIndex, 1);
    } else {
      const selectedDir = await window.electron.ipcRenderer.invoke("choose-path");
      if (!selectedDir) return;
      // 检查是否为子文件夹
      const defaultMusicPath = await window.electron.ipcRenderer.invoke("get-default-dir", "music");
      const allPath = [defaultMusicPath, ...settingStore.localFilesPath];
      const isSubfolder = await window.electron.ipcRenderer.invoke(
        "check-if-subfolder",
        allPath,
        selectedDir,
      );
      if (!isSubfolder) {
        settingStore.localFilesPath.push(selectedDir);
      } else {
        window.$message.error(t("message.local_path_overlapping"));
      }
    }
  } catch (error) {
    console.error("Error changing local path:", error);
    window.$message.error(t("message.change_local_path_fail"));
  }
};

/**
 * 洗牌数组（Fisher-Yates）
 */
export const shuffleArray = <T>(arr: T[]): T[] => {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

/**
 * 在浏览器空闲时执行任务
 * @param task 要执行的任务
 */
export const runIdle = (task: () => void) => {
  try {
    const ric = window?.requestIdleCallback as ((cb: () => void) => number) | undefined;
    if (typeof ric === "function") {
      ric(() => {
        try {
          task();
        } catch {
          /* empty */
        }
      });
    } else {
      setTimeout(() => {
        try {
          task();
        } catch {
          /* empty */
        }
      }, 0);
    }
  } catch {
    setTimeout(() => {
      try {
        task();
      } catch {
        /* empty */
      }
    }, 0);
  }
};

const WEIGHT_MAP = new Map([
  // --- 最具体的 ---
  ["extrabold", 800],
  ["ultrabold", 800],
  ["semibold", 600],
  ["demibold", 600],
  ["extralight", 200],
  ["ultralight", 200],
  // --- 日本 W 体系 ---
  ["w1", 100],
  ["w2", 200],
  ["w3", 300],
  ["w4", 400],
  ["w5", 500],
  ["w6", 600],
  ["w7", 700],
  ["w8", 800],
  ["w9", 900],
  // --- 通用名称 ---
  ["black", 900],
  ["heavy", 900],
  ["bold", 700],
  ["medium", 500],
  ["light", 300],
  ["hairline", 100],
  ["thin", 100],
  // --- 最通用的/别名 (放在最后) ---
  ["regular", 400],
  ["normal", 400],
  ["roman", 400],
  ["book", 400],
]);

export const parseFontDataStyle = (style: string) => {
  // 1. 安全处理：如果输入为空或非字符串，返回默认值
  if (!style) {
    return { fontWeight: 400, fontStyle: "normal" };
  }

  const lowerCaseStyle = style.toLowerCase();
  const normalizedWeightStyle = lowerCaseStyle.replace(/[\s-]/g, "");

  // 4. 查找字体权重 (font-weight)
  let fontWeight = 400; // 默认值为 'normal'
  for (const [keyword, value] of WEIGHT_MAP.entries()) {
    if (normalizedWeightStyle.includes(keyword)) {
      fontWeight = value;
      break; // 找到第一个匹配项（最具体的）后立刻停止
    }
  }

  // 5. 查找字体样式 (font-style)
  let fontStyle = "normal";
  if (lowerCaseStyle.includes("italic")) {
    fontStyle = "italic";
  } else if (lowerCaseStyle.includes("oblique")) {
    fontStyle = "oblique";
  }

  // 6. 返回最终结果
  return { fontWeight, fontStyle };
};

export const getShareUrl = (type: string, id: string, platform: string) => {
  const host = isElectron ? API_URL : location.origin;
  const u = new URL(host);
  const searchParams = new URLSearchParams({
    id,
    platform,
  });
  u.hash = `#/${type}?${searchParams.toString()}`;
  return u.toString();
};
