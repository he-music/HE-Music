import { h, watch, type Component } from "vue";
import { UpdatesSession, updatesSession } from "@/platform/updatesSession";
import { t } from "@/i18n";

export function createMygoUpdatePresenter(
  load: () => Promise<{ default: Component }> = () => import("@/components/Modal/MygoUpdate.vue"),
) {
  let opening: UpdatesSession | undefined;
  return async (session: UpdatesSession): Promise<void> => {
    if (opening === session || updatesSession.value !== session || !session.ready.value) return;
    opening = session;
    let created = false;
    try {
      const { default: MygoUpdate } = await load();
      if (updatesSession.value !== session || !session.ready.value) return;
      const modal = window.$modal.create({
        preset: "card",
        title: t("setting.about.check_update"),
        autoFocus: false,
        style: { width: "560px", maxWidth: "90vw" },
        content: () => h(MygoUpdate, { owner: session, onClose: () => modal.destroy() }),
        onAfterLeave: () => {
          stop();
          if (opening === session) opening = undefined;
        },
      });
      created = true;
      const stop = watch(updatesSession, (current) => {
        if (current !== session) modal.destroy();
      });
    } finally {
      if (!created && opening === session) opening = undefined;
    }
  };
}

export const openMygoUpdate = createMygoUpdatePresenter();
