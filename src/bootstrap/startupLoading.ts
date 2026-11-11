/** 启动恢复和失败入口也会调用，不依赖 Vue、状态管理或应用设置。 */
export function removeStartupLoading(): void {
  document.getElementById("startup-loading")?.remove();
  document.getElementById("startup-loading-style")?.remove();
}

/** 留出一帧绘制已就绪的首屏，再移除覆盖层。 */
export async function finishStartupLoading(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  removeStartupLoading();
}
