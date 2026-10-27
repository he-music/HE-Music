// Imported only by the opt-in development WK probe, never by a production entry.
import { nextTick } from "vue";
import { cloneDeep } from "lodash-es";
import { useDataStore, useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import audioManager from "@/utils/audioManager";
import songManager from "@/utils/songManager";
import lyricManager from "@/utils/lyricManager";
import { parseLineLyric } from "@/utils/lyric";
import type { SongInfo } from "@/types/main.hemusic";
import {
  installIsolation,
  prepareSurface,
  isolationDiagnostics,
  releaseIsolation,
} from "./isolation";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, stage: string) {
  const end = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > end) throw new Error(stage);
    await wait(40);
  }
}
const settings = () => useSettingStore();
const status = () => useStatusStore();
const music = () => useMusicStore();
const data = () => useDataStore();
const player = () => usePlayer();
let restore: (() => Promise<void>) | undefined;
let stage = "prepare";
const observedErrors: Array<{
  category: string;
  name: string;
  source: string;
  line: number;
  stage: string;
}> = [];
const observeError = (event: ErrorEvent) => {
  const category = String(event.message || "").includes("ResizeObserver")
    ? "resize-observer-loop"
    : "unclassified";
  let source = "external-or-runtime";
  try {
    const url = new URL(event.filename);
    if (
      url.origin === location.origin &&
      (url.pathname.startsWith("/src/") || url.pathname.startsWith("/node_modules/"))
    ) {
      source = url.pathname.split("/").at(-1) || source;
    }
  } catch {
    // 不保留未知来源的 URL 或错误正文。
  }
  observedErrors.push({
    category,
    name: event.error instanceof Error ? event.error.name : "ErrorEvent",
    source,
    line: event.lineno,
    stage,
  });
};
const frames = new Map<number, string>();
const fired: Record<string, number> = {};
const nativeRAF = window.requestAnimationFrame.bind(window);
const nativeCancel = window.cancelAnimationFrame.bind(window);
function frameGroup(stack: string) {
  if (stack.includes("/AMLL/LyricPlayer.vue")) return "amll";
  if (stack.includes("/Monet/")) return "monet";
  if (stack.includes("/PlayerLyric/DefaultLyric.vue")) return "default";
  if (stack.includes("useLyricPlaybackClock")) return "clock";
  return "other";
}
function observeFrames() {
  window.requestAnimationFrame = (callback) => {
    const group = frameGroup(new Error().stack || "");
    const id = nativeRAF((time) => {
      frames.delete(id);
      fired[group] = (fired[group] || 0) + 1;
      callback(time);
    });
    frames.set(id, group);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
    nativeCancel(id);
  };
}
function pending(group: string) {
  return [...frames.values()].filter((value) => value === group).length;
}
function song(id: string): SongInfo {
  return {
    id,
    platform: "nativeprobe",
    name: `WK synthetic ${id}`,
    subtitle: "Synthetic silence",
    artists: "Probe",
    album: "Probe",
    duration: 16000,
    mv_id: "",
    cover: "/images/song.jpg?asset",
    links: [{ name: "320mp3", quality: 320, format: "wav", size: "256000", url: "" }],
  };
}
const lines = parseLineLyric({
  lyric:
    "[00:00.00]Probe zero\n[00:02.00]Probe two\n[00:04.00]Probe four\n[00:06.00]Probe six\n[00:10.00]Probe ten\n[00:14.00]Probe end",
}).line;

export async function prepareAndCheckAudio(base: string) {
  const result: Record<string, unknown> = { passed: false, syntheticNetworkMedia: true };
  if (!import.meta.env.DEV || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) return result;
  installIsolation();
  const previous = {
    settings: {
      lyricRenderer: settings().lyricRenderer,
      playerType: settings().playerType,
      showYrc: settings().showYrc,
    },
    status: {
      showFullPlayer: status().showFullPlayer,
      pureLyricMode: status().pureLyricMode,
      playVolume: status().playVolume,
      playIndex: status().playIndex,
      radioMode: status().radioMode,
      currentTime: status().currentTime,
      duration: status().duration,
      progress: status().progress,
      lyricIndex: status().lyricIndex,
      playLoading: status().playLoading,
      lyricLoading: status().lyricLoading,
      playQuality: status().playQuality,
      currentTimeOffsetMap: cloneDeep(status().currentTimeOffsetMap),
    },
    song: cloneDeep(music().playSong),
    lyrics: cloneDeep(music().songLyric),
    list: cloneDeep(data().playList),
    url: songManager.getOnlineUrl,
    lyric: lyricManager.handleLyric,
    cover: songManager.getCoverColor,
    history: data().setHistory,
  };
  restore = async () => {
    try {
      await player().pause();
      audioManager.stop();
      status().showFullPlayer = false;
      await nextTick();
      await until(() => !document.querySelector(".full-player"), "full-player-unmount");
      await wait(80);
    } finally {
      songManager.getOnlineUrl = previous.url;
      lyricManager.handleLyric = previous.lyric;
      songManager.getCoverColor = previous.cover;
      data().setHistory = previous.history;
      settings().$patch(previous.settings);
      status().$patch(previous.status);
      music().playSong = previous.song;
      music().setSongLyric(previous.lyrics, true);
      data().playList = previous.list;
      window.requestAnimationFrame = nativeRAF;
      window.cancelAnimationFrame = nativeCancel;
      removeEventListener("error", observeError, true);
      releaseIsolation();
    }
  };
  addEventListener("error", observeError, true);
  observeFrames();
  try {
    const surface = await prepareSurface("prepare");
    result.surface = surface;
    if (!surface.passed) throw new Error("probe-surface");
    // Only fixed synthetic input boundaries are replaced. Player and AudioManager stay real.
    songManager.getOnlineUrl = async (id) => {
      if (id === "slow") await wait(300);
      if (!["a", "b", "slow"].includes(id)) throw new Error("unexpected synthetic id");
      return `${base}/${id === "b" ? "b" : "a"}.wav`;
    };
    lyricManager.handleLyric = async (id, platform) => {
      if (music().playSong.id !== id || platform !== "nativeprobe") return;
      music().setSongLyric({ lrcData: cloneDeep(lines), yrcData: [] }, true);
      status().lyricLoading = false;
    };
    songManager.getCoverColor = async () => {};
    data().setHistory = async () => {};
    settings().playerType = "cover";
    settings().showYrc = false;
    status().$patch({ radioMode: false, playIndex: 0, playVolume: 0 });
    data().playList = [song("a"), song("b"), song("slow")];
    stage = "preload";
    await player().initPlayer(false);
    await until(() => audioManager.duration > 0, "metadata");
    result.durationSeconds = audioManager.duration;
    result.preloadedPaused = audioManager.paused && !status().playStatus;
    stage = "programmatic-play";
    await player().play();
    await until(() => player().getSeek() > 350 && status().currentTime > 0, "time-advance");
    result.timeAdvanced = status().playStatus && status().currentTime > 0;
    stage = "pause";
    await player().pause();
    const pausedAt = player().getSeek();
    await wait(350);
    result.pauseStopped = Math.abs(player().getSeek() - pausedAt) < 80 && !status().playStatus;
    stage = "paused-seek";
    player().setSeek(4100);
    await until(() => Math.abs(player().getSeek() - 4100) < 150, "seek");
    result.pausedSeek = audioManager.paused;
    await player().play();
    await until(() => player().getSeek() > 4400, "resume");
    result.resumed = true;
    player().setSeek(2100);
    await until(() => player().getSeek() >= 2100 && player().getSeek() < 3500, "playing-seek");
    result.playingSeek = true;
    stage = "stale-url-switch";
    status().playIndex = 2;
    const stale = player().initPlayer(true);
    status().playIndex = 1;
    await player().initPlayer(true);
    await stale;
    await until(() => player().getSeek() > 250, "new-song-time");
    result.staleUrlIgnored =
      audioManager.src === `${base}/b.wav` &&
      music().playSong.id === "b" &&
      player().getSeek() < 3000;
    await player().pause();
    status().showFullPlayer = true;
    await nextTick();
    result.passed = [
      result.preloadedPaused,
      result.timeAdvanced,
      result.pauseStopped,
      result.pausedSeek,
      result.resumed,
      result.playingSeek,
      result.staleUrlIgnored,
    ].every((v) => v === true);
  } catch (error) {
    result.stage = stage;
    result.errorCategory = error instanceof Error ? error.name : "unknown";
  }
  return result;
}

function visible(element: Element | null) {
  if (!element) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
}
function activeText(effect: string) {
  if (effect === "monet")
    return document.querySelector('.monet-line[aria-current="true"]')?.textContent?.trim();
  if (effect === "default")
    return document.querySelector(".lyric .lrc-line.on")?.textContent?.trim();
  // AMLL uses generated CSS module classes; capture the rendered lyric line styles instead.
  const root = document.querySelector(".lyric-am .am-lyric");
  return root
    ? [...root.querySelectorAll("div")]
        .filter((el) => el.textContent?.trim() === "Probe four")
        .map((el) => el.getAttribute("style"))
        .join("|")
    : "";
}
export async function checkEffect(effect: "default" | "amll" | "monet") {
  const result: Record<string, unknown> = { passed: false, effect };
  try {
    stage = `effect-${effect}`;
    settings().lyricRenderer = effect;
    status().pureLyricMode = false;
    status().showFullPlayer = true;
    player().setSeek(500);
    await nextTick();
    const selector =
      effect === "default" ? ".lyric" : effect === "amll" ? ".lyric-am" : ".monet-rail";
    await until(
      () =>
        visible(document.querySelector(selector)) &&
        !!document.querySelector(selector)?.textContent?.includes("Probe"),
      "effect-mount",
    );
    await wait(250);
    const root = document.querySelector(selector)!;
    result.renderedText = root.textContent?.includes("Probe four") === true;
    result.width = Math.round(root.getBoundingClientRect().width);
    result.height = Math.round(root.getBoundingClientRect().height);
    const before = activeText(effect);
    player().setSeek(4500);
    await player().play();
    await until(() => player().getSeek() > 4750, "effect-play-time");
    const after = activeText(effect);
    result.clockAdvanced = player().getSeek() > 4650;
    result.domRespondedToSeek = !!after && after !== before;
    result.activeAfterSeek = effect === "amll" ? undefined : after;
    status().setSongOffset(music().playSong, 2000);
    await wait(150);
    result.offsetDomChanged = activeText(effect) !== after;
    status().setSongOffset(music().playSong, 0);
    await player().pause();
    await wait(700);
    const pausedCallbacksBefore = fired[effect] || 0;
    await wait(350);
    result.pausedEffectCallbackDelta = (fired[effect] || 0) - pausedCallbacksBefore;
    result.pausedEffectFrames = pending(effect);
    result.pausedClockFrames = pending("clock");
    result.effectFrameCallbacks = fired[effect] || 0;
    result.pausedEffectCleanupSkipped = effect === "amll";
    result.pausedEffectPolicy = effect === "amll" ? "existing-core-animation" : "stopped";
    const pausedDOM = activeText(effect);
    player().setSeek(2100);
    await wait(300);
    result.pausedSeekDomChanged = activeText(effect) !== pausedDOM && audioManager.paused;
    const updated = cloneDeep(lines);
    updated[2].words[0].word = "Probe four updated";
    music().setSongLyric({ lrcData: updated, yrcData: [] }, true);
    await until(
      () => !!document.querySelector(selector)?.textContent?.includes("Probe four updated"),
      "paused-content-update",
    );
    result.pausedContentUpdated = true;
    music().setSongLyric({ lrcData: cloneDeep(lines), yrcData: [] }, true);
    player().setSeek(4500);
    await wait(300);
    status().pureLyricMode = true;
    await until(
      () =>
        !!document.querySelector(`${selector}.pure`) ||
        !!document.querySelector(".player-content.pure"),
      "pure-layout",
    );
    await wait(700);
    result.pureLayout =
      !!document.querySelector(`${selector}.pure`) ||
      !!document.querySelector(".player-content.pure");
    result.pureWidth = Math.round(document.querySelector(selector)!.getBoundingClientRect().width);
    result.containerResized = result.pureWidth !== result.width;
    result.passed =
      result.renderedText === true &&
      result.pausedSeekDomChanged === true &&
      result.pausedContentUpdated === true &&
      result.clockAdvanced === true &&
      result.domRespondedToSeek === true &&
      result.pureLayout === true &&
      result.offsetDomChanged === true &&
      result.containerResized === true &&
      result.pausedClockFrames === 0 &&
      (effect === "amll" ||
        (result.pausedEffectCallbackDelta === 0 && result.pausedEffectFrames === 0));
  } catch (error) {
    result.stage = "effect-check";
    result.errorCategory = error instanceof Error ? error.name : "unknown";
  }
  return result;
}

export async function cleanup() {
  await restore?.();
  restore = undefined;
  return (
    audioManager.paused &&
    !document.querySelector(".player-lyric") &&
    pending("clock") === 0 &&
    pending("amll") === 0 &&
    pending("monet") === 0 &&
    pending("default") === 0
  );
}

export async function halfLayout() {
  status().pureLyricMode = false;
  await until(
    () => !!document.querySelector(".player-content:not(.pure) .player-lyric"),
    "half-layout",
  );
  await wait(700);
  return (
    !document.querySelector(".n-modal-container") &&
    !document.querySelector(".n-drawer") &&
    !status().playListShow &&
    visible(document.querySelector(".content-left"))
  );
}

export async function startVisibility() {
  await player().play();
  await until(() => !audioManager.paused, "visibility-play");
  await wait(100);
  return true;
}

export async function hiddenFrames() {
  await wait(500);
  return {
    visibility: document.visibilityState,
    clock: pending("clock"),
    amll: pending("amll"),
    monet: pending("monet"),
    default: pending("default"),
  };
}

export async function stopVisibility() {
  await player().pause();
  await wait(100);
  return { visibility: document.visibilityState, paused: audioManager.paused };
}

export function diagnostics() {
  return observedErrors;
}

export function probeIsolationDiagnostics() {
  return isolationDiagnostics();
}

export function prepareProbeSurface(phase: Parameters<typeof prepareSurface>[0]) {
  return prepareSurface(phase);
}
