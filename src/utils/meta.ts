import type { ImageRenderToolbarProps } from "naive-ui";

// 音质数据
export const songLevelData = {
  l: {
    level: "standard",
    name: "标准音质",
  },
  m: {
    level: "higher",
    name: "较高音质",
  },
  h: {
    level: "exhigh",
    name: "极高音质",
  },
  sq: {
    level: "lossless",
    name: "无损音质",
  },
  hr: {
    level: "hires",
    name: "Hi-Res",
  },
  je: {
    level: "jyeffect",
    name: "高清环绕声",
  },
  sk: {
    level: "sky",
    name: "沉浸环绕声",
  },
  db: {
    level: "dolby",
    name: "杜比全景声",
  },
  jm: {
    level: "jymaster",
    name: "超清母带",
  },
};

// 自定义图片工具栏
export const renderToolbar = ({ nodes }: ImageRenderToolbarProps) => {
  return [
    nodes.prev,
    nodes.next,
    nodes.rotateCounterclockwise,
    nodes.rotateClockwise,
    nodes.resizeToOriginalSize,
    nodes.zoomOut,
    nodes.zoomIn,
    nodes.close,
  ];
};

/**
 * 排序字段选项
 */
export const sortFieldOptions = {
  default: { name: "默认" },
  title: { name: "标题" },
  chapter: { name: "章节" },
  artist: { name: "歌手" },
  album: { name: "专辑" },
  duration: { name: "时长" },
  size: { name: "大小" },
} as const;

/**
 * 排序方式选项
 */
export const sortOrderOptions = {
  asc: { name: "升序" },
  desc: { name: "降序" },
} as const;
