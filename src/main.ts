import { platform } from "@/platform";
import { bootstrapWindow } from "./bootstrap/window";
import { isDesktopLyricsWindow } from "./bootstrap/windowRole";
import { initializeGateway } from "@/platform/gateway";

async function start(): Promise<void> {
  if (platform.kind === "mygo" && !isDesktopLyricsWindow(platform.kind, location.hash)) {
    if (!window.__HE_MUSIC_GATEWAY_ORIGIN__) throw new Error("本机网络网关未启动");
    await initializeGateway(
      platform.gateway,
      String(import.meta.env["VITE_API_URL"]),
      String(import.meta.env["VITE_NETEASE_API_URL"]),
    );
  }
  await bootstrapWindow(platform.kind, location.hash);
}

void start().catch((error: unknown) => {
  console.error("应用初始化失败", error);
});
