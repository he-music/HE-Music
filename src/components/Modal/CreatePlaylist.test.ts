import { afterEach, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const createLocal = vi.fn().mockResolvedValue("local-id");
const createOnline = vi.fn().mockResolvedValue({});
const push = vi.fn();
const login = vi.fn();
let signedIn = true;
let close: (() => void) | undefined;

function mount() {
  const Picker = defineComponent({
    props: { modelValue: String, disabled: Boolean },
    emits: ["update:modelValue", "loading"],
    setup(props, { emit }) {
      return () =>
        h("CoverPicker", {
          value: props.modelValue,
          onUpdateValue: (value: string) => emit("update:modelValue", value),
          onLoading: (value: boolean) => emit("loading", value),
        });
    },
  });
  const Form = defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots, expose }) {
      expose({ validate: async () => {} });
      return () => h("form", attrs, slots.default?.());
    },
  });
  const host = mountProductionSfc(
    new URL("./CreatePlaylist.vue", import.meta.url),
    {
      "test-form": { Form },
      "@/components/Local/LocalPlaylistCoverPicker.vue": { default: Picker },
      "vue-router": { useRouter: () => ({ push }) },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/utils/rules": { useFormRule: () => ({ textRule: {} }) },
      "@/utils/auth": { isLogin: () => signedIn, updateUserCreatedPlaylist: vi.fn() },
      "@/utils/modal": { openUserLogin: login },
      "@/stores/localPlaylists": { useLocalPlaylistStore: () => ({ create: createLocal }) },
      "@/stores/setting": { useSettingStore: () => ({ useOnlineService: true }) },
      "@/platform": { platform: { kind: "mygo", capabilities: { localMusic: true } } },
      "@/api/userplaylist": { createUserPlaylist: createOnline },
    },
    ["NTabs", "NTab", "NFormItem", "NInput", "NButton"],
    'import { Form as NForm } from "test-form";',
  );
  close = host.close;
  return host;
}

afterEach(() => {
  close?.();
  close = undefined;
  signedIn = true;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("在顶部切换本地歌单，保留封面与简介并进入独立详情页", async () => {
  vi.stubGlobal("window", { $message: { success: vi.fn(), error: vi.fn() } });
  const host = mount();
  const tabs = host.all().find((node) => node.tag === "NTabs")!;
  expect(tabs.props.value).toBe("online");
  emitHostEvent(tabs, "onUpdate:value", "local");
  await flushSfcHost();
  const inputs = host.all().filter((node) => node.tag === "NInput");
  expect(inputs).toHaveLength(2);
  emitHostEvent(inputs[0], "onUpdate:value", "本地歌单");
  emitHostEvent(inputs[1], "onUpdate:value", "歌单简介");
  emitHostEvent(
    host.all().find((node) => node.tag === "CoverPicker")!,
    "onUpdateValue",
    "https://cover.fixture.invalid/a.jpg",
  );
  const submit = host.all().find((node) => node.tag === "NButton")!;
  emitHostEvent(submit, "onClick");
  await flushSfcHost();
  expect(createLocal).toHaveBeenCalledWith("本地歌单", undefined, {
    name: "本地歌单",
    cover: "https://cover.fixture.invalid/a.jpg",
    description: "歌单简介",
  });
  expect(createOnline).not.toHaveBeenCalled();
  expect(login).not.toHaveBeenCalled();
  expect(push).toHaveBeenCalledWith({ name: "local-playlist", query: { id: "local-id" } });
});

it("切回在线歌单走原接口，未登录时才在提交在线歌单时请求登录", async () => {
  vi.stubGlobal("window", { $message: { success: vi.fn(), error: vi.fn() } });
  const host = mount();
  signedIn = false;
  const submit = host.all().find((node) => node.tag === "NButton")!;
  emitHostEvent(submit, "onClick");
  await flushSfcHost();
  expect(login).toHaveBeenCalledOnce();
  expect(createOnline).not.toHaveBeenCalled();
  signedIn = true;
  const inputs = host.all().filter((node) => node.tag === "NInput");
  emitHostEvent(inputs[0], "onUpdate:value", "在线歌单");
  emitHostEvent(submit, "onClick");
  await flushSfcHost();
  expect(createOnline).toHaveBeenCalledWith("在线歌单", "", "");
  expect(createLocal).not.toHaveBeenCalled();
});

it("图片导入期间阻止保存，切换在线歌单不会提交本地图片数据", async () => {
  vi.stubGlobal("window", { $message: { success: vi.fn(), error: vi.fn() } });
  const host = mount();
  const tabs = host.all().find((node) => node.tag === "NTabs")!;
  emitHostEvent(tabs, "onUpdate:value", "local");
  await flushSfcHost();
  const picker = host.all().find((node) => node.tag === "CoverPicker")!;
  emitHostEvent(picker, "onLoading", true);
  await flushSfcHost();
  const submit = host.all().find((node) => node.tag === "NButton")!;
  expect(submit.props.disabled).toBe(true);
  emitHostEvent(submit, "onClick");
  await flushSfcHost();
  expect(createLocal).not.toHaveBeenCalled();
  emitHostEvent(picker, "onUpdateValue", "data:image/jpeg;base64,imported");
  emitHostEvent(tabs, "onUpdate:value", "online");
  await flushSfcHost();
  emitHostEvent(
    host.all().find((node) => node.tag === "NInput")!,
    "onUpdate:value",
    "在线歌单",
  );
  emitHostEvent(submit, "onClick");
  await flushSfcHost();
  expect(createOnline).toHaveBeenCalledWith("在线歌单", "", "");
});
