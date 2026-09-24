/** Compare backing-buffer pixels, not fractional CSS pixels, before resizing WebGL. */
export function kineticBufferSize(width: number, height: number, resolution: number) {
  return {
    width: Math.max(1, Math.round(width * resolution)),
    height: Math.max(1, Math.round(height * resolution)),
  };
}
