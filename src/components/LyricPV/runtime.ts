import type { PVLyricRenderer } from "@/utils/lyric/renderer";
import type { AudioBands, Line, MotionValue, Theme } from "./vendor/types";

// 原版引擎共用 Vue 宿主契约；模块在选择效果后才加载。
export type PVMode = PVLyricRenderer;
export interface PVSong {
  seed: string;
  lines: Line[];
  duration: number;
  theme: Theme;
  title: string;
  artist: string;
  album: string;
}
export interface PVRuntime {
  swapSong(song: PVSong, signal: AbortSignal): Promise<void>;
  setPaused(paused: boolean): void;
  setStaticMode(reduced: boolean): void;
  renderOnce(): void;
  seek?(): void;
  destroy(): void;
}
export interface PVRuntimeOptions {
  host: HTMLDivElement;
  song: PVSong;
  currentTime: MotionValue<number>;
  audioPower: MotionValue<number>;
  audioBands: AudioBands;
  audioSpectrum?: () => Uint8Array | null;
  paused: boolean;
  reduced: boolean;
  signal: AbortSignal;
}

// 仅布局或主题变化时复用分镜，避免窗口缩放重新编译整首歌词。
export function createPVProgramCache<T>(compile: (song: PVSong) => T) {
  let cached: { song: PVSong; program: T } | undefined;
  return (song: PVSong): T => {
    if (
      cached &&
      cached.song.lines === song.lines &&
      cached.song.seed === song.seed &&
      cached.song.duration === song.duration
    )
      return cached.program;
    const program = compile(song);
    cached = { song, program };
    return program;
  };
}
export async function createPVRuntime(mode: PVMode, options: PVRuntimeOptions): Promise<PVRuntime> {
  if (mode === "52hz") {
    const { create52HzRuntime } = await import("./hz52/runtime");
    return create52HzRuntime(options);
  }
  const metadata = (song: PVSong) => ({
    title: song.title,
    artist: song.artist,
    album: song.album,
  });
  if (mode === "hanabi") {
    const [{ HanabiPixiRuntime }, { compileHanabiProgram }, { DEFAULT_HANABI_TUNING }] =
      await Promise.all([
        import("./vendor/components/visualizer/hanabi/createHanabiPixiRuntime"),
        import("./vendor/components/visualizer/hanabi/hanabiProgram"),
        import("./vendor/components/visualizer/hanabi/types"),
      ]);
    if (options.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const programFor = createPVProgramCache((song: PVSong) =>
      compileHanabiProgram(song.lines, song.seed, {}, { duration: song.duration }),
    );
    const songContext = (song: PVSong) => ({
      seed: song.seed,
      theme: song.theme,
      program: programFor(song),
    });
    const runtime = await HanabiPixiRuntime.create({
      ...options,
      song: songContext(options.song),
      tuning: { ...DEFAULT_HANABI_TUNING, sky: 0 },
      staticMode: options.reduced,
      showText: true,
      metadata: metadata(options.song),
      renderScale: 1,
      antialias: false,
    });
    return {
      swapSong: async (song, signal) => {
        runtime.setSongMetadata(metadata(song));
        await runtime.swapSong(songContext(song), signal);
      },
      setPaused: (paused) => runtime.setPaused(paused),
      setStaticMode: (reduced) => runtime.setStaticMode(reduced),
      renderOnce: () => runtime.renderOnce(),
      destroy: () => runtime.destroy(),
    };
  }
  const [{ LumierePixiRuntime }, { compileLumiereProgram }, { DEFAULT_LUMIERE_SCENE_TUNING }] =
    await Promise.all([
      import("./vendor/components/visualizer/lumiere/createLumierePixiRuntime"),
      import("./vendor/components/visualizer/lumiere/lumiereProgram"),
      import("./vendor/components/visualizer/lumiere/types"),
    ]);
  if (options.signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const programFor = createPVProgramCache((song: PVSong) =>
    compileLumiereProgram(song.lines, song.seed, {}, { duration: song.duration, seamless: true }),
  );
  const songContext = (song: PVSong) => ({
    seed: song.seed,
    theme: song.theme,
    program: programFor(song),
  });
  const runtime = await LumierePixiRuntime.create({
    ...options,
    song: songContext(options.song),
    tuning: {
      ...DEFAULT_LUMIERE_SCENE_TUNING,
      darkField: 0,
      trails: true,
      seamlessTransitions: true,
      render: { scale: "global", antialias: "global" },
      renderQuality: "full",
    },
    staticMode: options.reduced,
    showText: true,
    metadata: metadata(options.song),
    renderScale: 1,
    antialias: false,
  });
  return {
    swapSong: async (song, signal) => {
      runtime.setSongMetadata(metadata(song));
      await runtime.swapSong(songContext(song), signal);
    },
    setPaused: (paused) => runtime.setPaused(paused),
    setStaticMode: (reduced) => runtime.setStaticMode(reduced),
    renderOnce: () => runtime.renderOnce(),
    destroy: () => runtime.destroy(),
  };
}
