import { createI18n } from "vue-i18n";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

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
    en,
    "zh-CN": zhCN,
  },
});

export default i18n;

export const t: typeof i18n.global.t = i18n.global.t;
export const n: typeof i18n.global.n = i18n.global.n;
