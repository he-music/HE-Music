export interface RetirableScene {
  destroy(): void;
}

/** Detach the compositor surface before invalidating its active WebGL context. */
export function retireKineticScene(scene: RetirableScene, canvas?: HTMLCanvasElement) {
  canvas?.remove();
  let released = false;
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (firstFrame !== undefined) cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    clearTimeout(deadline);
    scene.destroy();
  };
  // The first RAF is before paint. Release on the following RAF, after the
  // browser has had a chance to composite the page without this canvas.
  firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(release);
  });
  // Hidden documents may not run RAF; resources must still be reclaimed.
  deadline = setTimeout(release, 200);
}
