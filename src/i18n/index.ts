import { createI18n } from "vue-i18n";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import libraryEN from "./locales/mygo/library.en.json";
import libraryZH from "./locales/mygo/library.zh-CN.json";
import downloadsEN from "./locales/mygo/downloads.en.json";
import downloadsZH from "./locales/mygo/downloads.zh-CN.json";
import fontsEN from "./locales/mygo/fonts.json";
import fontsZH from "./locales/mygo/fonts.zh-CN.json";
import proxyEN from "./locales/mygo/proxy.en.json";
import proxyZH from "./locales/mygo/proxy.zh-CN.json";
import taskbarEN from "./locales/mygo/taskbar.en.json";
import taskbarZH from "./locales/mygo/taskbar.zh-CN.json";
import protocolsEN from "./locales/mygo/protocols.en.json";
import protocolsZH from "./locales/mygo/protocols.zh-CN.json";
import appearanceEN from "./locales/mygo/appearance.en.json";
import appearanceZH from "./locales/mygo/appearance.zh-CN.json";
import audioEN from "./locales/mygo/audio.en.json";
import audioZH from "./locales/mygo/audio.zh-CN.json";
import preferencesResetEN from "./locales/mygo/preferencesReset.en.json";
import preferencesResetZH from "./locales/mygo/preferencesReset.zh-CN.json";

const numberFormats = {
  en: {
    number: {
      style: "decimal",
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 2,
    },
  },
  "zh-CN": {
    number: {
      style: "decimal",
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 2,
    },
  },
};

const i18n = createI18n({
  globalInjection: false,
  allowComposition: true,
  locale: "zh-CN",
  fallbackLocale: "zh-CN",
  numberFormats: numberFormats as any,
  messages: {
    en: {
      ...en,
      mygo: {
        ...libraryEN,
        ...downloadsEN,
        ...fontsEN,
        ...proxyEN,
        ...taskbarEN,
        ...appearanceEN,
        ...audioEN,
        ...preferencesResetEN,
        protocols: protocolsEN,
      },
    },
    "zh-CN": {
      ...zhCN,
      mygo: {
        ...libraryZH,
        ...downloadsZH,
        ...fontsZH,
        ...proxyZH,
        ...taskbarZH,
        ...appearanceZH,
        ...audioZH,
        ...preferencesResetZH,
        protocols: protocolsZH,
      },
    },
  },
});

export default i18n;

export const t: typeof i18n.global.t = i18n.global.t;
export const n: typeof i18n.global.n = i18n.global.n;
