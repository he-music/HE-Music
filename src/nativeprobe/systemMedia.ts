import { nextTick } from "vue";
import { platform } from "@/platform";
import { useMusicStore, useSettingStore, useStatusStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import { syntheticSystemArtwork } from "./systemArtwork";

/** Synthetic fixture in an isolated origin/profile, without audio URLs or OS input. */
export async function prepareSystemMediaProbe() {
  if (!import.meta.env.DEV || platform.kind !== "mygo" || !platform.systemMedia) {
    throw new Error("system media probe requires isolated development mygo");
  }
  const setting = useSettingStore();
  const music = useMusicStore();
  const status = useStatusStore();
  const player = usePlayer();
  if (setting.smtcOpen || setting.preventSleep) throw new Error("fixture must start disabled");
  const previous = {
    song: music.playSong,
    playing: status.playStatus,
    duration: status.duration,
    rate: status.playRate,
    play: player.play,
    pause: player.pause,
    next: player.nextOrPrev,
    seek: player.setSeek,
    getSeek: player.getSeek,
  };
  const calls: string[] = [];
  let position = 0;
  player.play = async () => {
    calls.push("play");
    status.playStatus = true;
  };
  player.pause = async () => {
    calls.push("pause");
    status.playStatus = false;
  };
  player.nextOrPrev = async (direction = "next") => {
    calls.push(direction);
  };
  player.setSeek = (value) => {
    calls.push(`seek:${value}`);
    position = value;
  };
  player.getSeek = () => position;
  music.playSong = {
    ...music.playSong,
    id: "system-media-fixture",
    platform: "nativeprobe",
    name: "HE-Music Synthetic System Media",
    artists: "Synthetic Artist",
    album: "Synthetic Album",
    cover: syntheticSystemArtwork,
    path: undefined,
  };
  status.duration = 16000;
  status.playRate = 1.25;
  status.playStatus = false;
  await nextTick();
  return {
    async enable() {
      setting.preventSleep = true;
      setting.smtcOpen = true;
      await nextTick();
      return true;
    },
    async clock() {
      for (let i = 0; i < 100; i++) {
        status.currentTime = i;
        status.lyricIndex = i;
        status.progress = i;
      }
      await nextTick();
      return true;
    },
    async artworkRate() {
      status.playRate = 2.5;
      await nextTick();
      return true;
    },
    calls: () => [...calls],
    async mediaOff() {
      setting.smtcOpen = false;
      await nextTick();
      return true;
    },
    async mediaOn() {
      setting.smtcOpen = true;
      await nextTick();
      return true;
    },
    async disable() {
      setting.smtcOpen = false;
      setting.preventSleep = false;
      await nextTick();
      return true;
    },
    async cleanup() {
      setting.smtcOpen = false;
      setting.preventSleep = false;
      player.play = previous.play;
      player.pause = previous.pause;
      player.nextOrPrev = previous.next;
      player.setSeek = previous.seek;
      player.getSeek = previous.getSeek;
      music.playSong = previous.song;
      status.playStatus = previous.playing;
      status.duration = previous.duration;
      status.playRate = previous.rate;
      await nextTick();
      await platform.lifecycle?.teardown();
      return true;
    },
  };
}
