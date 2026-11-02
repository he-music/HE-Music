import { afterEach, expect, it, vi } from "vitest";
import { computed, effectScope, nextTick, onScopeDispose, ref, watch } from "vue";
import type { SettingConfig } from "@/types/settings";
import { useScopedSettingConfig, useSettingActivation } from "./useSettingLifecycle";

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()));

it("keeps search construction inert and owns effects of locale replacements", async () => {
  const owner = effectScope();
  scopes.push(owner);
  const locale = ref("zh");
  const source = ref(0);
  const selected = ref("general");
  const samples: {
    value: number;
    enter: ReturnType<typeof vi.fn>;
    leave: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const configs = owner.run(() => {
    const play = useScopedSettingConfig(() => {
      const sample = { value: source.value, enter: vi.fn(), leave: vi.fn(), stop: vi.fn() };
      samples.push(sample);
      watch(
        source,
        (value) => {
          sample.value = value;
        },
        { flush: "sync" },
      );
      onScopeDispose(sample.stop);
      return {
        groups: [{ title: locale.value, items: [] }],
        onActivate: sample.enter,
        onDeactivate: sample.leave,
      };
    });
    const general = useScopedSettingConfig(() => ({ groups: [] }));
    useSettingActivation(computed(() => (selected.value === "play" ? play.value : general.value)));
    return { play, general };
  });
  if (!configs) throw new Error("missing settings");
  expect(configs.play.value.groups[0].title).toBe("zh");
  expect(samples[0].enter).not.toHaveBeenCalled();
  selected.value = "play";
  await nextTick();
  expect(samples[0].enter).toHaveBeenCalledOnce();
  locale.value = "en";
  await nextTick();
  expect(samples[0].leave).toHaveBeenCalledOnce();
  expect(samples[0].stop).toHaveBeenCalledOnce();
  expect(samples[1].enter).toHaveBeenCalledOnce();
  source.value = 1;
  expect(samples[0].value).toBe(0);
  expect(samples[1].value).toBe(1);
  selected.value = "general";
  await nextTick();
  expect(samples[1].leave).toHaveBeenCalledOnce();
  owner.stop();
  expect(samples[1].leave).toHaveBeenCalledOnce();
  expect(samples[1].stop).toHaveBeenCalledOnce();
  source.value = 2;
  expect(samples[1].value).toBe(1);
  expect(configs.play.value.groups[0].title).toBe("en");
});

it("deactivates the selected config on page disposal and never activates an absent tab", () => {
  const enter = vi.fn();
  const leave = vi.fn();
  const owner = effectScope();
  scopes.push(owner);
  owner.run(() => {
    const selected = ref<SettingConfig>();
    useSettingActivation(selected);
    selected.value = { groups: [], onActivate: enter, onDeactivate: leave };
  });
  owner.stop();
  expect(enter).not.toHaveBeenCalled();
  expect(leave).not.toHaveBeenCalled();
});
