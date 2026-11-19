import type { PlatformFullscreen } from "./types";

interface WebFullscreenDocument extends Document {
  readonly webkitFullscreenEnabled?: boolean;
  readonly webkitFullscreenElement?: Element | null;
  readonly webkitCurrentFullScreenElement?: Element | null;
  readonly webkitIsFullScreen?: boolean;
  webkitExitFullscreen?(): void | Promise<void>;
  webkitCancelFullScreen?(): void;
}

interface WebFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?(): void | Promise<void>;
  webkitRequestFullScreen?(): void;
}

export function createWebFullscreen(doc?: WebFullscreenDocument): PlatformFullscreen | null {
  const root: WebFullscreenElement | undefined = doc?.documentElement;
  if (!doc || !root) return null;

  const standard =
    doc.fullscreenEnabled !== false &&
    typeof root.requestFullscreen === "function" &&
    typeof doc.exitFullscreen === "function";
  const webkitEnter = root.webkitRequestFullscreen ?? root.webkitRequestFullScreen;
  const webkitExit = doc.webkitExitFullscreen ?? doc.webkitCancelFullScreen;
  const webkit = doc.webkitFullscreenEnabled !== false && webkitEnter && webkitExit;
  if (!standard && !webkit) return null;

  const current = () =>
    Boolean(
      doc.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.webkitCurrentFullScreenElement,
    ) || doc.webkitIsFullScreen === true;

  return {
    current,
    async toggle() {
      if (current()) {
        if (doc.fullscreenElement && typeof doc.exitFullscreen === "function") {
          await doc.exitFullscreen();
        } else if (webkitExit) await webkitExit.call(doc);
      } else if (standard) {
        await root.requestFullscreen();
      } else if (webkitEnter) {
        await webkitEnter.call(root);
      }
    },
    onChange(listener) {
      const update = () => listener(current());
      doc.addEventListener("fullscreenchange", update);
      doc.addEventListener("webkitfullscreenchange", update);
      return () => {
        doc.removeEventListener("fullscreenchange", update);
        doc.removeEventListener("webkitfullscreenchange", update);
      };
    },
  };
}
