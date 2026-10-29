import { shallowRef } from "vue";

export interface PlatformSystemFonts {
  list(): Promise<string[]>;
}

export interface SystemFontsLoader {
  list(): Promise<unknown>;
}

const MAX_SYSTEM_FONT_COUNT = 4096;
const MAX_SYSTEM_FONT_NAME = 512;

export function normalizeSystemFontFamilies(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (
      name.length === 0 ||
      name.length > MAX_SYSTEM_FONT_NAME ||
      name.startsWith(".") ||
      name.includes("\0") ||
      names.has(name)
    ) {
      continue;
    }
    names.add(name);
    if (names.size >= MAX_SYSTEM_FONT_COUNT) break;
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function createSystemFontsProvider(loader: SystemFontsLoader): PlatformSystemFonts {
  return {
    async list() {
      return normalizeSystemFontFamilies(await loader.list());
    },
  };
}

export interface SystemFontsSession {
  readonly fonts: Readonly<{ value: string[] }>;
  readonly loading: Readonly<{ value: boolean }>;
  readonly error: Readonly<{ value: unknown | null }>;
  load(): Promise<void>;
  dispose(): void;
}

export function createSystemFontsSession(provider: PlatformSystemFonts): SystemFontsSession {
  const fonts = shallowRef<string[]>([]);
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
        if (active && current === request) fonts.value = normalizeSystemFontFamilies(next);
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
