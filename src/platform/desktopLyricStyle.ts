export interface DesktopLyricStyle {
  playedColor: string;
  unplayedColor: string;
  shadowColor: string;
  textBackgroundMask: boolean;
}

export function createDefaultDesktopLyricStyle(): DesktopLyricStyle {
  return {
    playedColor: "#fe7971",
    unplayedColor: "#ccc",
    shadowColor: "rgba(0, 0, 0, 0.5)",
    textBackgroundMask: false,
  };
}

// 与 desktop/lyrics_style.go 共用有限语法：无外围空格，函数内仅允许 ASCII 空格。
const hexColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const rgbColor = /^rgb\( *([0-9]{1,3}) *, *([0-9]{1,3}) *, *([0-9]{1,3}) *\)$/i;
const rgbaColor =
  /^rgba\( *([0-9]{1,3}) *, *([0-9]{1,3}) *, *([0-9]{1,3}) *, *(0(?:\.[0-9]{1,6})?|1(?:\.0{1,6})?|\.[0-9]{1,6}) *\)$/i;

export function isDesktopLyricColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const hex = hexColor.exec(value);
  if (hex?.[0] === value) return true;
  const channels = rgbColor.exec(value) ?? rgbaColor.exec(value);
  return (
    channels !== null &&
    channels[0] === value &&
    channels.slice(1, 4).every((channel) => Number(channel) <= 255)
  );
}

export function parseDesktopLyricStyle(value: unknown): DesktopLyricStyle | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const style = createDefaultDesktopLyricStyle();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const field: unknown = descriptor.value;
    switch (key) {
      case "playedColor":
      case "unplayedColor":
      case "shadowColor":
        if (!isDesktopLyricColor(field)) return undefined;
        style[key] = field;
        break;
      case "textBackgroundMask":
        if (typeof field !== "boolean") return undefined;
        style.textBackgroundMask = field;
        break;
      default:
        return undefined;
    }
  }
  return style;
}
