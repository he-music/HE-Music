import localforage from "localforage";
import zh from "@/i18n/locales/mygo/preferencesReset.zh-CN.json";
import en from "@/i18n/locales/mygo/preferencesReset.en.json";

// Locale JSON only: importing the i18n/App tree here would hydrate old stores.
const recoveryText = () =>
  typeof navigator !== "undefined" && !navigator.language.startsWith("zh") ? en : zh;
import type { PreferencesResetMode } from "./preferencesReset";

export interface PreferencesResetTransaction {
  transactionId: string;
  mode: PreferencesResetMode;
  phase: string;
}
export interface PreferencesResetStartupProvider {
  pending(): Promise<PreferencesResetTransaction>;
  acknowledge(transactionId: string): Promise<void>;
}
export class PreferencesResetRecoveryError extends Error {}

const resetApplicationStores = [
  { name: "music-data", storeName: "music" },
  { name: "user-data", storeName: "user" },
  { name: "local-data", storeName: "local_download_history" },
  { name: "local-data", storeName: "local" },
  { name: "background-data", storeName: "background" },
] as const;

/** No stores, platform adapter, App or Pinia imports are allowed before this
 * finishes. Native keeps the same ID/mode durable until all work is acknowledged. */
export async function recoverPreferencesResetBeforeMount(
  native: PreferencesResetStartupProvider,
  storage: {
    local: Pick<Storage, "removeItem" | "clear">;
    session: Pick<Storage, "clear">;
  },
): Promise<void> {
  try {
    const tx = await native.pending();
    if (!tx.transactionId) return;
    if (tx.phase !== "renderer") {
      throw new Error(recoveryText().reset_restart_before_recovery);
    }
    if (tx.mode === "settings") {
      // Absence hydrates the real store's defaults; preserve shortcuts and history.
      storage.local.removeItem("setting-store");
    } else if (tx.mode === "all") {
      storage.local.clear();
      storage.session.clear();
      for (const store of resetApplicationStores) await localforage.dropInstance({ ...store });
    } else {
      throw new Error(recoveryText().reset_invalid_request);
    }
    await native.acknowledge(tx.transactionId);
  } catch (cause) {
    throw new PreferencesResetRecoveryError(recoveryText().reset_recovery_failed, { cause });
  }
}

/** A failed recovery must remain outside the normal application/store tree. */
export function showPreferencesResetRecoveryFailure(error: PreferencesResetRecoveryError): void {
  const target = document.getElementById("app");
  if (!target) return;
  const message = document.createElement("p");
  message.textContent = error.message;
  const reason = document.createElement("p");
  reason.textContent = error.cause instanceof Error ? error.cause.message : "";
  const retry = document.createElement("button");
  retry.textContent = recoveryText().reset_recovery_retry;
  retry.onclick = () => window.location.reload();
  target.replaceChildren(message, reason, retry);
}
