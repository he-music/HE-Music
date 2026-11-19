export function rgbToHex(r: number, g: number, b: number): string {
  const hex = [r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("");
  return `#${hex.toUpperCase()}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  const normalized =
    value.length === 3 ? Array.from(value, (digit) => digit.repeat(2)).join("") : value;
  if (normalized.length !== 6 || !/^[0-9a-f]{6}$/i.test(normalized)) return null;

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}
