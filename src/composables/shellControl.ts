import { watch } from "vue";
import { useMusicStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { ControlSession, type ControlProvider } from "@/platform/controlSession";

/** Long-lived shell only; never mount this consumer in an account or song view. */
export function createShellControlSession(provider: ControlProvider | undefined) {
  if (!provider) return;
  const music = useMusicStore();
  const player = usePlayer();
  let current = Symbol();
  let disposed = false;
  const canAutoPlay = () => !disposed;
  const stop = watch(
    () => [music.playSong, music.playSong?.id, music.playSong?.platform, music.playSong?.path],
    () => {
      current = Symbol();
    },
    { flush: "sync" },
  );
  const session = new ControlSession(
    provider,
    {
      current: () => current,
      async execute(action) {
        if (action === "play") await player.play(canAutoPlay);
        else if (action === "pause") await player.pause();
        else if (action === "toggle") await player.playOrPause(canAutoPlay);
        else await player.nextOrPrev(action, true, false, canAutoPlay);
      },
    },
    () => console.error("HTTP 播放控制操作失败"),
  );
  return {
    start: () => session.start(controlPort(import.meta.env.VITE_SERVER_PORT)),
    async dispose() {
      disposed = true;
      player.cancelPendingAutoplay(canAutoPlay);
      stop();
      await session.dispose();
    },
  };
}

export function controlPort(raw: unknown): number {
  if (raw === undefined || raw === "") return 0;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) throw new Error("Invalid control port");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid control port");
  return port;
}
