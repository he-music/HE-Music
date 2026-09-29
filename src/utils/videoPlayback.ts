import Plyr from "plyr";
import Hls from "hls.js";

export interface VideoSource {
  src: string;
  type: string;
  size: number;
}

/** 同一页面保留 Plyr 实例；source 更新后的媒体节点由 Plyr 管理。 */
export function createVideoPlayback(
  host: HTMLElement,
  options: Plyr.Options,
  onPlaying: () => void,
  onError: () => void,
  onHlsQualities: (qualities: number[]) => void = () => {},
) {
  const media = document.createElement("video");
  media.playsInline = true;
  media.controls = true;
  host.replaceChildren(media);
  const player = new Plyr(media, { ...options, autoplay: false });
  let hls: Hls | undefined;
  let generation = 0;
  let disposed = false;
  player.on("playing", onPlaying);

  const setSource = (sources: VideoSource[], title: string, poster: string) => {
    if (disposed || !sources.length) return;
    const current = ++generation;
    player.pause();
    hls?.destroy();
    hls = undefined;
    onHlsQualities([]);
    const first = sources[0];
    if (disposed || !first) return;
    const useHls = first.type === "application/x-mpegURL" && Hls.isSupported();
    player.source = {
      type: "video",
      title,
      poster,
      sources: useHls ? [{ ...first, src: "" }] : sources,
    };
    // source setter 会替换 video，必须重新读取 player.media。
    const currentMedia = host.querySelector("video");
    if (!currentMedia) {
      onError();
      return;
    }
    const play = () => {
      if (!disposed && generation === current && options.autoplay) {
        void currentMedia.play().catch(() => {});
      }
    };
    currentMedia.addEventListener(
      "error",
      () => {
        if (!disposed && generation === current) onError();
      },
      { once: true },
    );
    if (useHls) {
      const stream = new Hls();
      hls = stream;
      stream.on(Hls.Events.MANIFEST_PARSED, () => {
        if (disposed || generation !== current) return;
        onHlsQualities([...new Set(stream.levels.map((level) => level.height))].filter(Boolean));
        play();
      });
      stream.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal && !disposed && generation === current) onError();
      });
      stream.attachMedia(currentMedia);
      stream.loadSource(first.src);
    } else {
      play();
    }
  };

  return {
    setHlsQuality: (height: number) => {
      if (hls) hls.currentLevel = hls.levels.findIndex((level) => level.height === height);
    },
    pause: () => player.pause(),
    setSource,
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      hls?.destroy();
      player.destroy();
      host.replaceChildren();
    },
  };
}
