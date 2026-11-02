import {
  initializeApplicationStorage,
  type ApplicationStorageProvider,
} from "./applicationStorage";
import zh from "@/i18n/locales/mygo/storage.zh-CN.json";
import en from "@/i18n/locales/mygo/storage.en.json";
const text = () => (navigator.language.startsWith("zh") ? zh : en);

export class ApplicationStorageRecoveryError extends Error {}

export async function prepareApplicationStorageBeforeMount(
  native: ApplicationStorageProvider,
): Promise<void> {
  try {
    await initializeApplicationStorage(native);
  } catch (cause) {
    throw new ApplicationStorageRecoveryError(text().data_read_failed, { cause });
  }
}

export function showApplicationStorageRecoveryFailure(
  error: ApplicationStorageRecoveryError,
): void {
  const target = document.getElementById("app");
  if (!target) return;
  const message = document.createElement("p");
  message.textContent = error.message;
  const retry = document.createElement("button");
  retry.textContent = text().data_retry;
  retry.onclick = () => window.location.reload();
  target.replaceChildren(message, retry);
}
