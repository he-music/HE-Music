import { installApplicationLogging } from "@/platform/applicationLog";
import { applicationStorage } from "@/platform/applicationStorage";
import {
  prepareApplicationStorageBeforeMount,
  ApplicationStorageRecoveryError,
  showApplicationStorageRecoveryFailure,
} from "@/platform/applicationStorageStartup";
import { isMyGo } from "mygo-runtime";
import {
  recoverPreferencesResetBeforeMount,
  PreferencesResetRecoveryError,
  showPreferencesResetRecoveryFailure,
} from "@/platform/preferencesResetStartup";
import { bootstrapWindow } from "./bootstrap/window";
import { isDesktopLyricsWindow } from "./bootstrap/windowRole";
import { initializeGateway } from "@/platform/gateway";
import { showStartupFailure } from "./bootstrap/startupFailure";

async function start(): Promise<void> {
  if (isMyGo() && !isDesktopLyricsWindow("mygo", location.hash)) {
    const { DesktopPlatform, DesktopStorage, DesktopLog } =
      await import("@/platform/mygo.bindings");
    const stopLogging = installApplicationLogging(DesktopLog);
    import.meta.hot?.dispose(stopLogging);
    await prepareApplicationStorageBeforeMount(DesktopStorage);
    await recoverPreferencesResetBeforeMount(
      {
        pending: () => DesktopPlatform.pendingPreferencesReset(),
        acknowledge: (id) => DesktopPlatform.acknowledgePreferencesReset(id),
      },
      { local: applicationStorage, session: sessionStorage },
    );
  }
  const { platform } = await import("@/platform");
  if (platform.kind === "mygo" && !isDesktopLyricsWindow(platform.kind, location.hash)) {
    if (!window.__HE_MUSIC_GATEWAY_ORIGIN__) throw new Error("本机网络网关未启动");
    await initializeGateway(platform.gateway, String(import.meta.env["VITE_API_URL"]));
  }
  await bootstrapWindow(platform.kind, location.hash);
}

void start().catch((error: unknown) => {
  console.error("应用初始化失败", error);
  if (error instanceof PreferencesResetRecoveryError) {
    showPreferencesResetRecoveryFailure(error);
  } else if (error instanceof ApplicationStorageRecoveryError) {
    showApplicationStorageRecoveryFailure(error);
  } else {
    showStartupFailure();
  }
});
