const primary = "183, 220, 157";
const background = "10, 21, 17";
const panel = "23, 39, 33";
const text = "#f1f7ef";
const secondary = "#c6d8cd";

export const pineAfterRain = {
  id: "pine-after-rain",
  labelKey: "setting.general.theme_skin_pine_after_rain",
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
      primaryColorHover: "#cce9b4",
      primaryColorPressed: "#9ec694",
      primaryColorSuppl: `rgb(${primary})`,
      textColor1: text,
      textColor2: "#dbe8df",
      textColor3: secondary,
      bodyColor: `rgb(${background})`,
      cardColor: `rgb(${panel})`,
      modalColor: `rgb(${panel})`,
      popoverColor: "#1d3129",
      borderColor: "rgba(182, 218, 198, 0.18)",
      hoverColor: "rgba(158, 201, 167, 0.12)",
    },
  },
} as const;
