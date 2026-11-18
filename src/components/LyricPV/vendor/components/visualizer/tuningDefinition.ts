// 数值校验适配：仅供上游渲染参数归一化使用，不导入 Folia 设置系统。
export const numberWithin = (raw: unknown, fallback: number, min: number, max: number) =>
  typeof raw === "number" && Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : fallback;
