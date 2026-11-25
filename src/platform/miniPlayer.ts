import type { BindingMethods } from "./bindingMethods";
import { DesktopMiniPlayer, events } from "./mygo.bindings";
import type { MiniPlayerClosed, MiniPlayerCommand, MiniPlayerView } from "./mygo.bindings";

export interface PlatformMiniPlayer extends BindingMethods<typeof DesktopMiniPlayer> {
  onClosed(listener: (event: MiniPlayerClosed) => void): () => void;
  onCommand(listener: (event: MiniPlayerCommand) => void): () => void;
  onView(listener: (event: MiniPlayerView) => void): () => void;
}

export const mygoMiniPlayer: PlatformMiniPlayer = {
  ...DesktopMiniPlayer,
  onClosed: (listener) => events.desktopMiniPlayerClosed.on(listener),
  onCommand: (listener) => events.desktopMiniPlayerCommand.on(listener),
  onView: (listener) => events.desktopMiniPlayerState.on(listener),
};
