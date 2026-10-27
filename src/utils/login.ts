import { useDataStore, usePlatformStore, useSettingStore, useStatusStore } from "@/stores";
import { updateUserData } from "./auth";
import { usePlayer } from "./player";

export interface LoginResult {
  access_token?: string;
  token?: string;
  refresh_token?: string;
  expires_at?: number;
}

/** 接受结果时同步写入凭据；后续用户/平台刷新不再属于可取消的授权尝试。 */
export async function completeLogin(result: LoginResult): Promise<void> {
  const token = result.access_token || result.token;
  if (!token) throw new Error("Missing login token");
  const dataStore = useDataStore();
  const platformStore = usePlatformStore();
  const statusStore = useStatusStore();
  const settingStore = useSettingStore();
  const player = usePlayer();
  dataStore.token = token;
  dataStore.refreshToken = result.refresh_token || "";
  dataStore.expiresAt = result.expires_at || 0;
  dataStore.userLoginStatus = true;
  localStorage.setItem("lastLoginTime", Date.now().toString());
  // 用户数据局部刷新失败也应尝试刷新平台，避免成功登录后保留匿名平台列表。
  const updates = await Promise.allSettled([updateUserData(), platformStore.loadPlatforms()]);
  if (statusStore.playLoading) player.initPlayer(settingStore.autoPlay, player.getSeek());
  if (updates.some((update) => update.status === "rejected")) {
    throw new Error("Login data refresh failed");
  }
}

/** 提前移除一次性 query，避免刷新/重复挂载重复兑换；保留已有回到根页面的语义。 */
export async function finishWebOAuth(deps: {
  url: string;
  clearQuery(url: string): void;
  exchange(state: string): Promise<LoginResult>;
  accept(result: LoginResult): Promise<void>;
  success(): void;
  failure(): void;
  replace(url: string): void;
}): Promise<void> {
  const url = new URL(deps.url);
  const state = url.searchParams.get("state");
  if (!state) return;
  url.searchParams.delete("state");
  deps.clearQuery(`${url.pathname}${url.search}${url.hash}`);
  try {
    const result = await deps.exchange(state);
    await deps.accept(result);
    deps.success();
  } catch {
    deps.failure();
  }
  deps.replace("/");
}
