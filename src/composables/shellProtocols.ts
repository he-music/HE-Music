import { watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter, type Router } from "vue-router";
import { useSettingStore } from "@/stores";
import {
  ProtocolSession,
  type PlatformProtocols,
  type ProtocolIntent,
} from "@/platform/protocolSession";

export interface ProtocolNavigationDependencies {
  owner(): unknown;
  router: Pick<Router, "isReady" | "push">;
  reportFailure(): void;
}

/** Navigation borrows both the shell owner and the session's latest intent. */
export function createProtocolNavigationHandler(deps: ProtocolNavigationDependencies) {
  return async (intent: ProtocolIntent, active: () => boolean): Promise<void> => {
    const owner = deps.owner();
    const current = () => owner !== undefined && deps.owner() === owner && active();
    if (!current()) return;
    try {
      await deps.router.isReady();
      if (!current()) return;
      await deps.router.push({
        name: "song",
        query: { platform: intent.platform, id: intent.songId },
      });
    } catch {
      if (current()) deps.reportFailure();
    }
  };
}

/** The parent starts this only after lifecycle Ready and disposes before lifecycle teardown. */
export function createShellProtocolSession(provider: PlatformProtocols | undefined) {
  if (!provider) return;
  const setting = useSettingStore();
  const router = useRouter();
  const { t } = useI18n();
  const identity = Symbol("protocol shell");
  let owner: symbol | undefined;
  let disposed = false;
  let stopWatch: (() => void) | undefined;
  const handle = createProtocolNavigationHandler({
    owner: () => owner,
    router,
    reportFailure: () => window.$message?.error(t("message.get_song_detail_fail")),
  });
  const session = new ProtocolSession(
    provider,
    (intent, current) => {
      void handle(intent, current);
    },
    (results) => {
      const reasons = new Set(results?.map((result) => result.reason));
      const key = reasons.has("missing-declaration")
        ? "mygo.protocols.missing_declaration"
        : reasons.has("bundle-registration-failed")
          ? "mygo.protocols.bundle_registration_failed"
          : reasons.has("not-default")
            ? "mygo.protocols.not_default"
            : "mygo.protocols.association_failed";
      window.$message?.warning(t(key));
    },
  );
  return {
    async start() {
      if (disposed || owner === identity) return;
      owner = identity;
      stopWatch = watch(
        () => [...setting.registryProtocols],
        (schemes) => {
          void session.sync(schemes);
        },
        { flush: "sync" },
      );
      await session.start([...setting.registryProtocols]);
    },
    dispose() {
      disposed = true;
      owner = undefined;
      stopWatch?.();
      return session.dispose();
    },
  };
}
