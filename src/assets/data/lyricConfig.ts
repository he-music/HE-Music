import type { LyricConfig } from "../../types/desktop-lyric";

const config: LyricConfig = {
  isLock: false,
  playedColor: "#fe7971",
  unplayedColor: "#ccc",
  shadowColor: "rgba(0, 0, 0, 0.5)",
  showTran: true,
  showYrc: true,
  isDoubleLine: true,
  position: "both",
  limitBounds: false,
  textBackgroundMask: false,
  alwaysShowPlayInfo: false,
  animation: true,
  font: {
    family: "system-ui",
    size: 24,
    weight: 700,
    postScriptName: "system-ui",
    style: "normal",
  },
};

export default config;
