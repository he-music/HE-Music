import {
  initializeApplicationStorage,
  type ApplicationStorageProvider,
} from "./applicationStorage";
import { showStartupFailure } from "@/bootstrap/startupFailure";
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
  showStartupFailure({ message: error.message });
}
