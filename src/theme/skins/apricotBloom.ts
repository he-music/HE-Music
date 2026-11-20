const primary = "125, 56, 71";
const background = "250, 244, 236";
const panel = "255, 251, 246";
const text = "#35252a";
const secondary = "#4f363e";

export const apricotBloom = {
  id: "apricot-bloom",
  labelKey: "setting.general.theme_skin_apricot_bloom",
  mode: "light",
  cssVariables: {
    "--skin-primary-rgb": primary,
    "--skin-base-rgb": background,
    "--skin-panel-rgb": panel,
    "--skin-text": text,
    "--skin-secondary": secondary,
  },
  themeOverrides: {
    common: {
      primaryColor: `rgb(${primary})`,
      primaryColorHover: "#91475a",
      primaryColorPressed: "#662c39",
      primaryColorSuppl: `rgb(${primary})`,
      textColor1: text,
      textColor2: "#493339",
      textColor3: secondary,
      bodyColor: `rgb(${background})`,
      cardColor: `rgb(${panel})`,
      modalColor: `rgb(${panel})`,
      popoverColor: "#fffaf4",
      borderColor: "#e4d6cb",
      hoverColor: "rgba(125, 56, 71, 0.09)",
    },
  },
} as const;
