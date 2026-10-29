export interface DesktopLyricOptions {
  font: {
    family: string;
    size: number;
    weight: number;
    postScriptName: string;
    style: "normal" | "italic" | "oblique";
  };
  isDoubleLine: boolean;
  position: "left" | "center" | "right" | "both";
  limitBounds: boolean;
  showYrc: boolean;
  showTran: boolean;
  animation: boolean;
  alwaysShowPlayInfo: boolean;
}

export function createDefaultDesktopLyricOptions(): DesktopLyricOptions {
  return {
    font: {
      family: "system-ui",
      size: 24,
      weight: 700,
      postScriptName: "system-ui",
      style: "normal",
    },
    isDoubleLine: true,
    position: "both",
    limitBounds: false,
    showYrc: true,
    showTran: true,
    animation: true,
    alwaysShowPlayInfo: false,
  };
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// 与 desktop/lyrics_options.go 一致：单一字体名，UTF-8 至多 256 字节。
function isFontName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith(" ") &&
    !value.endsWith(" ") &&
    !/[^\p{L}\p{N} _.-]/u.test(value) &&
    new TextEncoder().encode(value).length <= 256
  );
}

function parseFont(value: unknown): DesktopLyricOptions["font"] | undefined {
  if (!isPlainObject(value)) return undefined;
  const font = createDefaultDesktopLyricOptions().font;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const field: unknown = descriptor.value;
    switch (key) {
      case "family":
      case "postScriptName":
        if (!isFontName(field)) return undefined;
        font[key] = field;
        break;
      case "size":
        if (typeof field !== "number" || !Number.isInteger(field) || field < 20 || field > 96)
          return undefined;
        font.size = field;
        break;
      case "weight":
        if (typeof field !== "number" || field < 100 || field > 900 || field % 100 !== 0)
          return undefined;
        font.weight = field;
        break;
      case "style":
        if (field !== "normal" && field !== "italic" && field !== "oblique") return undefined;
        font.style = field;
        break;
      default:
        return undefined;
    }
  }
  return font;
}

// 仅 TS 接受部分字段并补默认；Go 的非 nil 值必须已经完整有效。
export function parseDesktopLyricOptions(value: unknown): DesktopLyricOptions | undefined {
  try {
    if (!isPlainObject(value)) return undefined;
    const options = createDefaultDesktopLyricOptions();
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      const field: unknown = descriptor.value;
      switch (key) {
        case "font": {
          const font = parseFont(field);
          if (!font) return undefined;
          options.font = font;
          break;
        }
        case "position":
          if (field !== "left" && field !== "center" && field !== "right" && field !== "both")
            return undefined;
          options.position = field;
          break;
        case "isDoubleLine":
        case "limitBounds":
        case "showYrc":
        case "showTran":
        case "animation":
        case "alwaysShowPlayInfo":
          if (typeof field !== "boolean") return undefined;
          options[key] = field;
          break;
        default:
          return undefined;
      }
    }
    return options;
  } catch {
    // 对异常或已撤销的 Proxy 同样按非法输入处理。
    return undefined;
  }
}
