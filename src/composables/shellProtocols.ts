import { watch } from "vue";
import { useI18n } from "vue-i18n";
import { songInfo } from "@/api/song";
import { useSettingStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import type { SongInfo } from "@/types/main.hemusic";
import {
  ProtocolSession,
  type PlatformProtocols,
  type ProtocolIntent,
} from "@/platform/protocolSession";

export interface ProtocolPlaybackDependencies<T> {
  owner(): unknown;
  songInfo(platform: string, id: string): Promise<{ list?: T[] }>;
  addNextSong(song: T, play: boolean): Promise<unknown>;
  reportFailure(): void;
}

/** Each API request borrows both the shell owner and the session's latest intent. */
export function createProtocolPlaybackHandler<T>(deps: ProtocolPlaybackDependencies<T>) {
  return async (intent: ProtocolIntent, active: () => boolean): Promise<void> => {
    const owner = deps.owner();
    const current = () => owner !== undefined && deps.owner() === owner && active();
    if (!current()) return;
    try {
      const result = await deps.songInfo(intent.platform, intent.songId);
      if (!current()) return;
      const song = result.list?.[0];
      if (!song) {
        deps.reportFailure();
        return;
      }
      await deps.addNextSong(song, true);
    } catch {
      if (current()) deps.reportFailure();
    }
  };
}

/** The parent starts this only after lifecycle Ready and disposes before lifecycle teardown. */
export function createShellProtocolSession(provider: PlatformProtocols | undefined) {
  if (!provider) return;
  const setting = useSettingStore();
  const player = usePlayer();
  const { t } = useI18n();
  const identity = Symbol("protocol shell");
  let owner: symbol | undefined;
  let disposed = false;
  let stopWatch: (() => void) | undefined;
  const handle = createProtocolPlaybackHandler<SongInfo>({
    owner: () => owner,
    songInfo,
    addNextSong: (song, play) => player.addNextSong(song, play),
    reportFailure: () => window.$message?.error(t("message.song_play_fail")),
  });
  const session = new ProtocolSession(
    provider,
    (intent, current) => {
      void handle(intent, current);
    },
    () => window.$message?.warning(t("mygo.protocols.association_failed")),
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
