import type { ScanEntry } from "./mygo.bindings";

const cueTrackSuffix = /:cue:([1-9][0-9]?)$/;

export interface CueRange {
  start: number;
  end: number;
  /** 最后一轨由引擎报告文件结束，其余轨道用 CUE 边界。 */
  last: boolean;
}

export const cueTrackID = (songID: string, track: number) => songID + ":cue:" + track;
export const isCueTrack = (songID: string) =>
  songID.startsWith("mygo-local:") && cueTrackSuffix.test(songID);

export function cueRangeFor(entry: ScanEntry, songID: string): CueRange | undefined {
  if (!isCueTrack(songID) || !entry.cue) return;
  const number = Number(cueTrackSuffix.exec(songID)?.[1]);
  const tracks = entry.cue.tracks;
  const index = tracks.findIndex((track) => track.number === number);
  if (index < 0) return;
  const next = tracks[index + 1];
  return {
    start: (tracks[index].startFrame * 1000) / 75,
    end: next ? (next.startFrame * 1000) / 75 : entry.metadata.DurationSeconds * 1000,
    last: !next,
  };
}
