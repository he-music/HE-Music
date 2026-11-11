import type { PlaybackEngineId } from "@/core/audio-player/IPlaybackEngine";
import type { Link, SongInfo } from "@/types/main.hemusic";
import { getSongCanPlayLinks } from "./song";

interface QualityPreferences {
  engine: PlaybackEngineId;
  requested: string;
  configured: string;
  current: string;
  selected: string;
}

/** 音质选择只依赖歌曲与偏好，不修改播放状态。 */
export function selectPlaybackQuality(
  song: SongInfo,
  preferences: QualityPreferences,
): Link | null {
  const links = getSongCanPlayLinks(song, preferences.engine);
  if (!links.length) return null;
  const requested = links.find((link) => link.name === preferences.requested);
  if (requested) return requested;
  const priorities = [preferences.configured, preferences.current, preferences.selected];
  if (preferences.configured === "auto") {
    priorities.unshift(preferences.selected, "hires", "flac", "320mp3", "128mp3");
  }
  for (const quality of priorities) {
    const link = links.find((item) => item.name === quality);
    if (link) return link;
  }
  return links[0];
}
