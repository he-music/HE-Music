const primary = "255, 209, 151";
const background = "9, 13, 25";
const panel = "21, 27, 46";
const text = "#f5f6fc";
const secondary = "#d3daeb";

export const iceLake = {
  id: "ice-lake",
  labelKey: "setting.general.theme_skin_ice_lake",
  mode: "dark",
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
      primaryColorHover: "#ffdab4",
      primaryColorPressed: "#efa9bb",
      primaryColorSuppl: `rgb(${primary})`,
      textColor1: text,
      textColor2: "#dfe4f0",
      textColor3: secondary,
      bodyColor: `rgb(${background})`,
      cardColor: `rgb(${panel})`,
      modalColor: `rgb(${panel})`,
      popoverColor: "#171d31",
      borderColor: "rgba(223, 213, 246, 0.14)",
      hoverColor: "rgba(241, 161, 189, 0.09)",
    },
  },
} as const;
