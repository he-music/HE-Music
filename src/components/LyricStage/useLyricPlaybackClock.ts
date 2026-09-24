import { computed, onScopeDispose, ref, watch } from "vue";

/** Freeze at the pause command, not the eventual end of the audio fade-out. */
export function useLyricPlaybackClock(options: {
  playing: () => boolean;
  visible: () => boolean;
  identity: () => string;
  offset: () => number;
  readTime: () => number;
  subscribeSeek: (sample: () => void) => () => void;
}) {
  const sampled = ref(options.readTime());
  let frame: number | undefined;
  const sample = () => {
    sampled.value = options.readTime();
  };
  function stop() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }
  function tick() {
    frame = undefined;
    if (!options.playing() || !options.visible()) return;
    sample();
    frame = requestAnimationFrame(tick);
  }
  watch(
    [options.playing, options.visible, options.identity],
    ([playing, , identity], previous) => {
      stop();
      // Visibility changes while paused must not read a still-fading audio clock.
      if (!previous || playing || previous[0] !== playing || previous[2] !== identity) sample();
      if (playing && options.visible()) frame = requestAnimationFrame(tick);
    },
    { immediate: true, flush: "sync" },
  );
  const unsubscribe = options.subscribeSeek(sample);
  onScopeDispose(() => {
    stop();
    unsubscribe();
  });
  return computed(() => sampled.value + options.offset());
}
