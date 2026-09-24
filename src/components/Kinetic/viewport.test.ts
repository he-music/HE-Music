import { describe, expect, it } from "vitest";
import { kineticBufferSize } from "./viewport";

describe("kinetic WebGL backing buffer", () => {
  it.each([
    [1, 592, 350],
    [1.25, 740, 438],
    [1.5, 888, 525],
    [2, 1185, 701],
  ])("uses stable integer pixels at resolution %s", (resolution, width, height) => {
    const buffer = kineticBufferSize(592.25, 350.25, resolution);
    expect(buffer).toEqual({ width, height });
    // Pixi's quantized screen dimensions must map back to the very same buffer.
    expect(kineticBufferSize(width / resolution, height / resolution, resolution)).toEqual(buffer);
  });
  it("ignores subpixel jitter but responds when a physical-pixel boundary is crossed", () => {
    expect(kineticBufferSize(592.1, 350.1, 2)).toEqual(kineticBufferSize(592.2, 350.2, 2));
    expect(kineticBufferSize(592.3, 350.3, 2)).toEqual({ width: 1185, height: 701 });
    expect(kineticBufferSize(0.1, 0.1, 1)).toEqual({ width: 1, height: 1 });
  });
});
