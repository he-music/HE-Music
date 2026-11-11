import { shallowRef } from "vue";

export interface SystemFont {
  family: string;
  fullName: string;
  postScriptName: string;
  weight: number;
  style: string;
}

export interface PlatformSystemFonts {
  list(): Promise<SystemFont[]>;
}

export interface SystemFontsLoader {
  list(): Promise<unknown>;
}

const MAX_SYSTEM_FONT_COUNT = 4096;
const MAX_SYSTEM_FONT_NAME = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const fallbackSystemFont = (family: string): SystemFont => ({
  family,
  fullName: family,
  postScriptName: family,
  weight: 400,
  style: "normal",
});

export function normalizeSystemFonts(value: unknown): SystemFont[] {
  if (!Array.isArray(value)) return [];
  const fonts: SystemFont[] = [];
  const names = new Set<string>();
  for (const item of value) {
    const font =
      typeof item === "string"
        ? fallbackSystemFont(item)
        : isRecord(item) && typeof item.family === "string"
          ? {
              family: item.family,
              fullName: typeof item.fullName === "string" ? item.fullName : item.family,
              postScriptName:
                typeof item.postScriptName === "string" ? item.postScriptName : item.family,
              weight: typeof item.weight === "number" ? item.weight : 400,
              style: typeof item.style === "string" ? item.style : "normal",
            }
          : null;
    if (!font) continue;
    const family = font.family.trim();
    const fullName = font.fullName.trim();
    const postScriptName = font.postScriptName.trim();
    if (
      family.length === 0 ||
      family.length > MAX_SYSTEM_FONT_NAME ||
      fullName.length === 0 ||
      fullName.length > MAX_SYSTEM_FONT_NAME ||
      postScriptName.length === 0 ||
      postScriptName.length > MAX_SYSTEM_FONT_NAME ||
      family.startsWith(".") ||
      family.includes("\0") ||
      fullName.includes("\0") ||
      postScriptName.includes("\0") ||
      names.has(postScriptName)
    ) {
      continue;
    }
    names.add(postScriptName);
    fonts.push({
      family,
      fullName,
      postScriptName,
      weight:
        Number.isInteger(font.weight) && font.weight >= 100 && font.weight <= 900
          ? font.weight
          : 400,
      style: ["normal", "italic", "oblique"].includes(font.style) ? font.style : "normal",
    });
    if (fonts.length >= MAX_SYSTEM_FONT_COUNT) break;
  }
  return fonts.sort(
    (left, right) =>
      left.fullName.localeCompare(right.fullName) ||
      left.postScriptName.localeCompare(right.postScriptName),
  );
}

export function normalizeSystemFontFamilies(value: unknown): string[] {
  return [...new Set(normalizeSystemFonts(value).map((font) => font.family))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export interface SystemFontsSession {
  readonly fonts: Readonly<{ value: SystemFont[] }>;
  readonly loading: Readonly<{ value: boolean }>;
  readonly error: Readonly<{ value: unknown | null }>;
  load(): Promise<void>;
  dispose(): void;
}

export function createSystemFontsProvider(loader: SystemFontsLoader): PlatformSystemFonts {
  return {
    async list() {
      return normalizeSystemFonts(await loader.list());
    },
  };
}

export function createSystemFontsSession(provider: PlatformSystemFonts): SystemFontsSession {
  const fonts = shallowRef<SystemFont[]>([]);
  const loading = shallowRef(false);
  const error = shallowRef<unknown | null>(null);
  let active = true;
  let request = 0;

  return {
    fonts,
    loading,
    error,
    async load() {
      const current = ++request;
      loading.value = true;
      error.value = null;
      try {
        const next = await provider.list();
        if (active && current === request) fonts.value = normalizeSystemFonts(next);
      } catch (reason) {
        if (active && current === request) error.value = reason;
      } finally {
        if (active && current === request) loading.value = false;
      }
    },
    dispose() {
      active = false;
      request++;
    },
  };
}
