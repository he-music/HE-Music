import type { DialogReactive } from "naive-ui";
import { t } from "@/i18n";
import { platform } from "@/platform";

/** 设置面板停用或所选值改变后，旧提示不能再发起重启。 */
export function createSettingsRestartPrompt() {
  let dialog: DialogReactive | undefined;
  const dismiss = () => {
    const previous = dialog;
    dialog = undefined;
    previous?.destroy();
  };
  const show = (
    current: () => boolean,
    messageKey = "message.setting_saved_and_restart_required",
  ) => {
    dismiss();
    if (!current()) return;
    const lifecycle = platform.lifecycle;
    if (!lifecycle) {
      window.$message.warning(t(messageKey));
      return;
    }
    let pending = false;
    const release = () => {
      if (dialog === prompt) dialog = undefined;
    };
    const isCurrent = () => dialog === prompt && current() && platform.lifecycle === lifecycle;
    const prompt = window.$dialog.warning({
      title: t("common.warning"),
      content: t(messageKey),
      positiveText: t("common.restart_now"),
      negativeText: t("common.later"),
      onNegativeClick: release,
      onClose: release,
      onAfterLeave: release,
      onPositiveClick: async () => {
        if (pending || !isCurrent()) return false;
        pending = true;
        prompt.loading = true;
        try {
          await lifecycle.restart();
          release();
          return true;
        } catch {
          if (isCurrent()) window.$message.error(t("message.restart_failed"));
          return false;
        } finally {
          pending = false;
          prompt.loading = false;
        }
      },
    });
    dialog = prompt;
  };
  return { show, dismiss };
}
