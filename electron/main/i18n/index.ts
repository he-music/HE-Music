import i18next from "i18next";

// 导入语言文件
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

// 初始化i18next
export const initI18n = async () => {
  return i18next.init({
    lng: "zh-CN",
    fallbackLng: "zh-CN",
    resources: {
      en: {
        translation: en,
      },
      "zh-CN": {
        translation: zhCN,
      },
    },
    interpolation: {
      escapeValue: false,
    },
  });
};

export const t = i18next.t;
export const changeLanguage = i18next.changeLanguage;
