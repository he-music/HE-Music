import { afterEach, expect, it, vi } from "vitest";
import { reactive, shallowRef } from "vue";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const processing = shallowRef(false);
const state = reactive({
  eqEnabled: false,
  eqPreset: "custom",
  eqBands: Array<number>(10).fill(0),
  setEqEnabled: vi.fn((value: boolean) => {
    state.eqEnabled = value;
  }),
  setEqBands: vi.fn((bands: number[]) => {
    state.eqBands = bands;
  }),
  setEqPreset: vi.fn((value: string) => {
    state.eqPreset = value;
  }),
});
const player = { enableEq: vi.fn(), disableEq: vi.fn(), updateEq: vi.fn() };
let close: (() => void) | undefined;
function mount() {
  const host = mountProductionSfc(
    new URL("./Equalizer.vue", import.meta.url),
    {
      "@/utils/audioManager": { audioProcessingAvailable: processing },
      "@/stores": { useStatusStore: () => state },
      "@/utils/player": { usePlayer: () => player },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    },
    ["NFlex", "NAlert", "NTag", "NSwitch", "NSlider"],
    'import { ref, watch } from "vue";',
  );
  close = host.close;
  return host;
}
afterEach(() => {
  close?.();
  close = undefined;
  processing.value = false;
  state.eqEnabled = false;
  state.eqPreset = "custom";
  state.eqBands = Array<number>(10).fill(0);
  vi.clearAllMocks();
});
it("the real EQ template explains a source restriction and enables controls when its graph becomes available", async () => {
  const host = mount();
  expect(host.all().some((target) => target.text.includes("mygo.audio.effects_unavailable"))).toBe(
    true,
  );
  expect(host.all().find((target) => target.tag === "NSwitch")?.props.disabled).toBe(true);
  processing.value = true;
  await flushSfcHost();
  const toggle = host.all().find((target) => target.tag === "NSwitch");
  if (!toggle) throw new Error("Missing equalizer switch");
  expect(toggle.props.disabled).toBe(false);
  emitHostEvent(toggle, "onUpdate:value", true);
  await flushSfcHost();
  expect(state.eqEnabled).toBe(true);
  expect(player.enableEq).toHaveBeenCalledOnce();
  expect(
    host
      .all()
      .filter((target) => target.tag === "NSlider")
      .every((target) => target.props.disabled === false),
  ).toBe(true);
  processing.value = false;
  await flushSfcHost();
  expect(
    host
      .all()
      .filter((target) => target.tag === "NSlider")
      .every((target) => target.props.disabled === true),
  ).toBe(true);
  expect(state.eqEnabled).toBe(true);
  expect(player.disableEq).not.toHaveBeenCalled();
});
