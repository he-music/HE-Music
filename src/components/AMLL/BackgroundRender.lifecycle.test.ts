import { afterEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { mountProductionSfc } from "@/test/productionSfc";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.useRealTimers();
});

function fixture(playing = true) {
  const visibility = Vue.ref("visible");
  const props = Vue.reactive({ playing, album: "https://images.invalid/cover.jpg" });
  const renderer = {
    getElement: () => ({ style: {} }),
    setAlbum: vi.fn(),
    setFPS: vi.fn(),
    setFlowSpeed: vi.fn(),
    setRenderScale: vi.fn(),
    setLowFreqVolume: vi.fn(),
    setHasLyric: vi.fn(),
    setStaticMode: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    dispose: vi.fn(),
  };
  const create = vi.fn(() => renderer);
  const host = mountProductionSfc(
    new URL("./BackgroundRender.vue", import.meta.url),
    {
      vue: {
        ...Vue,
        useTemplateRef: () => Vue.shallowRef({ appendChild: vi.fn() }),
      },
      "@vueuse/core": { useDocumentVisibility: () => visibility },
      "@applemusic-like-lyrics/core": {
        BackgroundRender: { new: create },
        MeshGradientRenderer: class {},
      },
    },
    [],
    'import { computed, shallowRef, useTemplateRef, onMounted, onBeforeUnmount, watch } from "vue";',
    () => ({ ...props }),
  );
  cleanups.push(host.close);
  return { host, props, visibility, renderer, create };
}

it("卸载时释放渲染器一次，反复挂载不遗留销毁定时器", () => {
  vi.useFakeTimers();
  for (let n = 0; n < 20; n++) {
    const { host, renderer } = fixture();
    host.close();
    host.close();
    expect(renderer.pause).toHaveBeenCalledTimes(1);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("隐藏时暂停、恢复可见时继续运行同一渲染器", async () => {
  const { visibility, renderer, create } = fixture();
  expect(renderer.resume).toHaveBeenCalledTimes(1);
  visibility.value = "hidden";
  await Vue.nextTick();
  expect(renderer.pause).toHaveBeenCalledTimes(1);
  visibility.value = "visible";
  await Vue.nextTick();
  expect(renderer.resume).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledTimes(1);
});

it("暂停时展开或重新展开会绘制封面，并在播放时恢复流动", async () => {
  for (let count = 0; count < 2; count++) {
    const { host, props, renderer } = fixture(false);
    expect(renderer.setStaticMode).toHaveBeenLastCalledWith(true);
    expect(renderer.resume).toHaveBeenCalledOnce();
    expect(renderer.pause).not.toHaveBeenCalled();
    expect(renderer.setAlbum).toHaveBeenCalledWith(props.album, false);

    props.playing = true;
    await Vue.nextTick();
    expect(renderer.setStaticMode).toHaveBeenLastCalledWith(false);

    props.playing = false;
    await Vue.nextTick();
    expect(renderer.setStaticMode).toHaveBeenLastCalledWith(true);
    host.close();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  }
});

it("隐藏时保持暂停，恢复可见后绘制暂停期间切换的封面", async () => {
  const { props, visibility, renderer, create } = fixture(false);
  visibility.value = "hidden";
  await Vue.nextTick();
  expect(renderer.pause).toHaveBeenCalledOnce();

  props.album = "https://images.invalid/next.jpg";
  await Vue.nextTick();
  expect(renderer.setAlbum).toHaveBeenLastCalledWith(props.album, false);
  expect(renderer.resume).toHaveBeenCalledOnce();

  visibility.value = "visible";
  await Vue.nextTick();
  expect(renderer.setStaticMode).toHaveBeenLastCalledWith(true);
  expect(renderer.resume).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledOnce();
});
