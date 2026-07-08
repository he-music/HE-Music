import { useSettingStore } from "@/stores";
import { FontStyleSelection } from "@/types/global";
import { kebabCase } from "lodash-es";

export interface LyricFontConfig {
  keySetting: "lyricFont" | "japaneseLyricFont" | "englishLyricFont" | "koreanLyricFont";
  default: "follow" | FontStyleSelection;
}

export interface LyricLangFontConfig extends LyricFontConfig {
  keyPrefixCss: string;
}

export const lyricLangFontConfigs: LyricLangFontConfig[] = [
  {
    keySetting: "englishLyricFont",
    keyPrefixCss: "--en-",
    default: "follow",
  },
  {
    keySetting: "japaneseLyricFont",
    keyPrefixCss: "--ja-",
    default: "follow",
  },
  {
    keySetting: "koreanLyricFont",
    keyPrefixCss: "--ko-",
    default: "follow",
  },
];

export const lyricFontConfigs: LyricFontConfig[] = [
  {
    keySetting: "lyricFont",
    default: "follow",
  },
  ...lyricLangFontConfigs,
];

export const lyricLangFontStyle = (settingStore = useSettingStore()) => {
  return Object.fromEntries(
    lyricLangFontConfigs
      .map((c) => {
        const settingValue = settingStore[c.keySetting];

        const css = lyricFontStyle(settingValue);

        return Object.keys(css).map((key) => {
          return [c.keyPrefixCss + kebabCase(key), css[key]];
        });
      })
      .flat(),
  );
};

// 'follow' | FontStyleSelection 转换成样式表
export const lyricFontStyle = (v: "follow" | FontStyleSelection) => {
  if (v == "follow") {
    return {
      fontFamily: "",
      fontWeight: "",
      fontStyle: "",
    };
  }
  return {
    fontFamily: v.family,
    fontWeight: v.weight,
    fontStyle: v.style,
  };
};
