// src/utils/lyric/language.ts — 不依赖播放器或网络的歌词语言检测。
/**
 * 检测歌词语言
 * @param lyric 歌词内容
 * @returns 语言代码（"ja" | "zh-CN" | "en"）
 */
export const getLyricLanguage = (lyric: string): "ja" | "ko" | "zh-CN" | "en" => {
  if (!lyric) return "en";
  // 判断日语 根据平假名和片假名
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(lyric)) return "ja";
  // 判断韩语 根据韩文音节
  if (/[\uAC00-\uD7AF]/.test(lyric)) return "ko";
  // 判断简体中文 根据中日韩统一表意文字基本区
  if (/[\u4E00-\u9FFF]/.test(lyric)) return "zh-CN";
  // 默认英语
  return "en";
};
