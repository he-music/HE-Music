import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { parse, compileScript } from "vue/compiler-sfc";
import ts from "typescript";
import { createQrLoginFlow } from "@/utils/qrLogin";

// 编译真实 SFC 的 script setup；用 Vue 自定义 renderer 运行生命周期，无 DOM/账号依赖。
function mountScript(file: string, modules: Record<string, unknown>, props = {}) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8").replace(
    '<script setup lang="ts">',
    `<script setup lang="ts">
import { ref, shallowRef, computed, watch, onMounted, onBeforeMount, onBeforeUnmount, onUnmounted } from "vue";`,
  );
  const { descriptor } = parse(source);
  if (!descriptor.scriptSetup) throw new Error("Missing script setup");
  const compiled = compileScript(descriptor, { id: file });
  const code = ts.transpileModule(compiled.content, {
    fileName: "login.ts",
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { default?: { setup(props: object, context: object): Record<string, unknown> } } =
    {};
  new Function("require", "exports", code)((name: string) => {
    if (name === "vue") return Vue;
    if (!(name in modules)) throw new Error(`Unexpected SFC import: ${name}`);
    return modules[name];
  }, exports);
  const setup = exports.default?.setup;
  if (!setup) throw new Error("Missing compiled setup");
  const emit = vi.fn();
  const state: { value: Record<string, unknown> } = { value: {} };
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert: () => {},
    remove: () => {},
    setText: () => {},
    setElementText: () => {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp: () => {},
  });
  const app = renderer.createApp({
    setup() {
      state.value = setup(props, { expose: () => {}, emit });
      return () => null;
    },
  });
  app.mount({});
  return { state, emit, unmount: () => app.unmount() };
}
function call(state: Record<string, unknown>, key: string) {
  const fn = state[key];
  if (typeof fn !== "function") throw new Error(`Missing ${key}`);
  return fn();
}
const i18n = { useI18n: () => ({ t: (key: string) => key }) };
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("登录 SFC 真实 setup 生命周期", () => {
  it("LoginQRCode pause阻止创建，恢复后发请求；卸载丢弃迟到create", async () => {
    const props = Vue.reactive({ pause: true });
    const pending = deferred<object>();
    const create = vi.fn(() => pending.promise);
    const component = mountScript(
      "./LoginQRCode.vue",
      {
        "@/api/auth": {
          createQrLoginSession: create,
          exchangeQrLoginResult: vi.fn(),
          getQrLoginSessionStatus: vi.fn(),
        },
        "@/utils/qrLogin": { createQrLoginFlow },
        "@/platform": { platform: { kind: "mygo", os: "darwin" } },
        "vue-i18n": i18n,
        "@/utils/device": { getDeviceInfo: async () => ({}) },
        "@/constants/links": { MOBILE_APP_RELEASE_URL: "https://example.test" },
      },
      props,
    );
    await flush();
    expect(create).not.toHaveBeenCalled();
    props.pause = false;
    await Vue.nextTick();
    await flush();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]).toEqual([
      {
        client_type: "electron_vue",
        client_name: "HE Music MacOS",
        scene: "desktop_login",
        device_info: {},
      },
    ]);
    component.unmount();
    pending.resolve({
      session_id: "late",
      result_token: "synthetic",
      qr_content: "synthetic",
      status: "confirmed",
    });
    await flush();
    expect(component.emit).not.toHaveBeenCalled();
  });
  it("LoginPassword卸载后迟到密码响应不emit，暂停切换也取消旧代号", async () => {
    for (const boundary of ["unmount", "pause"]) {
      const pending = deferred<object>();
      const login = vi.fn(() => pending.promise);
      const props = Vue.reactive({ pause: false });
      const component = mountScript(
        "./LoginPassword.vue",
        {
          axios: { default: { isAxiosError: () => false } },
          "@/api/login": { accountLogin: login },
          "@/utils/rules": { useFormRule: () => ({}) },
          "vue-i18n": i18n,
          "@/utils/device": { getDeviceInfo: async () => ({}) },
        },
        props,
      );
      const form = component.state.value.formRef;
      if (!Vue.isRef(form)) throw new Error("Missing form ref");
      form.value = { validate: async () => {} };
      const run = call(component.state.value, "login");
      await flush();
      expect(login).toHaveBeenCalledOnce();
      if (boundary === "unmount") component.unmount();
      else {
        props.pause = true;
        props.pause = false;
        await Vue.nextTick();
      }
      pending.resolve({ access_token: "synthetic" });
      await run;
      expect(component.emit).not.toHaveBeenCalled();
      if (boundary === "pause") component.unmount();
    }
  });
  it("密码暂停后可立即重试，旧请求不能解除新请求的 loading", async () => {
    const first = deferred<object>();
    const second = deferred<object>();
    const login = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const props = Vue.reactive({ pause: false });
    const component = mountScript(
      "./LoginPassword.vue",
      {
        axios: { default: { isAxiosError: () => false } },
        "@/api/login": { accountLogin: login },
        "@/utils/rules": { useFormRule: () => ({}) },
        "vue-i18n": i18n,
        "@/utils/device": { getDeviceInfo: async () => ({}) },
      },
      props,
    );
    const form = component.state.value.formRef;
    const loading = component.state.value.loading;
    if (!Vue.isRef(form) || !Vue.isRef(loading)) throw new Error("Missing form state");
    form.value = { validate: async () => {} };
    try {
      const oldRun = call(component.state.value, "login");
      await flush();
      props.pause = true;
      props.pause = false;
      const newRun = call(component.state.value, "login");
      await flush();
      expect(login).toHaveBeenCalledTimes(2);
      first.resolve({ access_token: "old-synthetic" });
      await oldRun;
      expect(component.emit).not.toHaveBeenCalled();
      expect(loading.value).toBe(true);
      second.resolve({ access_token: "new-synthetic" });
      await newRun;
      expect(component.emit).toHaveBeenCalledExactlyOnceWith("saveLogin", {
        access_token: "new-synthetic",
      });
      expect(loading.value).toBe(false);
    } finally {
      first.resolve({});
      second.resolve({});
      component.unmount();
    }
  });
  it("Login绑定关闭取消和成功卸载的完成边界，provider迟到不更新", async () => {
    const providers = deferred<{ list: string[] }>();
    const accepted = deferred<void>();
    const cancel = vi.fn();
    const complete = vi.fn(() => accepted.promise);
    const component = mountScript("./Login.vue", {
      "@/utils/login": { completeLogin: complete },
      "@/stores": { useDataStore: () => ({ userLoginStatus: false }) },
      "@/components/Modal/Login/LoginPassword.vue": {},
      "@/components/Layout/Logo.vue": {},
      "vue-i18n": i18n,
      "@/api/auth": { createAuthSession: vi.fn(), authProviders: () => providers.promise },
      "@/components/Global/SvgIcon.vue": {},
      "@/utils/device": { getDeviceInfo: async () => ({}) },
      "@/platform/auth": { createDesktopOAuth: () => ({ cancel, start: vi.fn() }) },
      "@/platform": { platform: { kind: "mygo" } },
    });
    const save = component.state.value.saveLogin;
    if (typeof save !== "function") throw new Error("Missing saveLogin");
    const success = vi.fn();
    vi.stubGlobal("window", { $message: { success, error: vi.fn() } });
    const run = save({ access_token: "synthetic" });
    expect(complete).toHaveBeenCalledOnce();
    expect(component.emit).toHaveBeenCalledWith("close");
    component.unmount();
    providers.resolve({ list: ["late"] });
    accepted.resolve();
    await run;
    await flush();
    expect(success).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalled();
    const list = component.state.value.providers;
    expect(Vue.isRef(list) && list.value).toEqual([]);
    vi.unstubAllGlobals();
  });
});
