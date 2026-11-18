// 同时满足横向和纵向限制，保留词级放大、旋转及阶梯位移的空间。
export function fitStageContent(
  width: number,
  height: number,
  contentWidth: number,
  contentHeight: number,
): number {
  return Math.max(
    0.05,
    Math.min(
      1,
      Math.max(1, width - 48) / Math.max(1, contentWidth),
      Math.max(1, height - 48) / Math.max(1, contentHeight),
    ),
  );
}
