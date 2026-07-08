export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VirtualScreenBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 校正桌面歌词窗口初始位置。
 * 旧坐标完全落到当前虚拟屏幕外时，将窗口拉回到主屏可见区域。
 */
export const resolveLyricWindowBounds = (
  bounds: WindowBounds,
  virtualBounds: VirtualScreenBounds,
): WindowBounds => {
  const maxVisibleX = virtualBounds.maxX - bounds.width;
  const maxVisibleY = virtualBounds.maxY - bounds.height;
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, virtualBounds.minX), maxVisibleX),
    y: Math.min(Math.max(bounds.y, virtualBounds.minY), maxVisibleY),
  };
};
