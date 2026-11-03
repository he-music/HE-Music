import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { parse, compileScript } from "vue/compiler-sfc";
import ts from "typescript";
import { createQrLoginFlow } from "@/utils/qrLogin";
import { createOAuthFlow, type OAuthDependencies } from "@/platform/oauthFlow";

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

function mountOAuthLogin() {
  const session = {
    url: "https://example.test/oauth",
    state: "synthetic-state",
    check_interval: 2,
    expires_at: Date.now() / 1000 + 120,
  };
  const deps = {
    create: vi.fn<OAuthDependencies["create"]>(async () => session),
    status: vi.fn<OAuthDependencies["status"]>(async () => ({
      status: "pending",
      error: "",
      check_interval: 2,
      expires_at: session.expires_at,
    })),
    exchange: vi.fn<OAuthDependencies["exchange"]>(async () => ({
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_at: Date.now() / 1000 + 3600,
    })),
    open: vi.fn(async () => {}),
  };
  const complete = vi.fn(async () => {});
  const notifications = { success: vi.fn(), error: vi.fn() };
  vi.stubGlobal("window", { $message: notifications });
  const component = mountScript("./Login.vue", {
    "@/utils/login": { completeLogin: complete },
    "@/stores": { useDataStore: () => ({ userLoginStatus: false }) },
    "@/components/Modal/Login/LoginPassword.vue": {},
    "@/components/Layout/Logo.vue": {},
    "vue-i18n": i18n,
    "@/api/auth": { authProviders: async () => ({ list: ["LinuxDo", "Other"] }) },
    "@/components/Global/SvgIcon.vue": {},
    "@/utils/device": { getDeviceInfo: async () => ({}) },
    "@/platform/auth": {
      createDesktopOAuth: (
        accept: OAuthDependencies["accept"],
        onError: OAuthDependencies["onError"],
        onPendingChange: OAuthDependencies["onPendingChange"],
      ) => createOAuthFlow({ ...deps, accept, onError, onPendingChange }),
    },
    "@/platform": { platform: { kind: "mygo" } },
  });
  const value = (key: string) => {
    const field = component.state.value[key];
    if (!Vue.isRef(field)) throw new Error(`Missing ref ${key}`);
    return field;
  };
  const start = async (provider = "LinuxDo") => {
    const login = component.state.value.oauthLogin;
    if (typeof login !== "function") throw new Error("Missing OAuth handler");
    await login(provider);
  };
  return { component, deps, session, complete, notifications, value, start };
}

describe("OAuth 登录等待与取消", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("整个等待期间保持 loading，阻止重复发起，取消后可重试且不关闭弹窗", async () => {
    const s = mountOAuthLogin();
    try {
      await s.start();
      expect(s.value("oauthPending").value).toBe(true);
      expect(s.value("oauthProvider").value).toBe("LinuxDo");
      await s.start("Other");
      expect(s.deps.create).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2000);
      expect(s.value("oauthPending").value).toBe(true);
      call(s.component.state.value, "cancelOAuth");
      expect(s.value("oauthPending").value).toBe(false);
      expect(s.value("oauthProvider").value).toBe("");
      expect(s.deps.create.mock.calls[0][1].aborted).toBe(true);
      expect(s.component.emit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await s.start("Other");
      expect(s.deps.create).toHaveBeenCalledTimes(2);
      expect(s.value("oauthPending").value).toBe(true);
    } finally {
      s.component.unmount();
    }
  });

  it.each(["cancel", "switch", "close", "unmount"])(
    "%s 结束等待，迟到授权不能登录",
    async (boundary) => {
      const s = mountOAuthLogin();
      const pending = deferred<Awaited<ReturnType<OAuthDependencies["status"]>>>();
      s.deps.status.mockReturnValueOnce(pending.promise);
      try {
        await s.start();
        await vi.advanceTimersByTimeAsync(2000);
        if (boundary === "cancel") call(s.component.state.value, "cancelOAuth");
        if (boundary === "switch") s.value("activeTab").value = "login-qr";
        if (boundary === "close") call(s.component.state.value, "closeLogin");
        if (boundary === "unmount") s.component.unmount();
        expect(s.value("oauthPending").value).toBe(false);
        pending.resolve({
          status: "success",
          error: "",
          check_interval: 2,
          expires_at: s.session.expires_at,
        });
        await flush();
        expect(s.deps.exchange).not.toHaveBeenCalled();
        expect(s.complete).not.toHaveBeenCalled();
        expect(s.notifications.error).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        if (boundary !== "unmount") s.component.unmount();
      }
    },
  );

  it.each(["failed", "expired", "timeout"] as const)(
    "%s 后恢复登录选项并可再次发起",
    async (status) => {
      const s = mountOAuthLogin();
      try {
        if (status === "timeout") s.session.expires_at = Date.now() / 1000 + 3;
        else
          s.deps.status.mockResolvedValueOnce({
            status,
            error: "",
            check_interval: 2,
            expires_at: 0,
          });
        await s.start();
        await vi.advanceTimersByTimeAsync(3000);
        expect(s.value("oauthPending").value).toBe(false);
        expect(s.notifications.error).toHaveBeenCalledOnce();
        expect(s.component.emit).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        s.session.expires_at = Date.now() / 1000 + 120;
        await s.start();
        expect(s.value("oauthPending").value).toBe(true);
      } finally {
        s.component.unmount();
      }
    },
  );

  it("成功时结束 loading 并关闭弹窗，卸载不撤回登录结果", async () => {
    const s = mountOAuthLogin();
    try {
      s.deps.status.mockResolvedValueOnce({
        status: "success",
        error: "",
        check_interval: 2,
        expires_at: s.session.expires_at,
      });
      await s.start();
      await vi.advanceTimersByTimeAsync(2000);
      expect(s.value("oauthPending").value).toBe(false);
      expect(s.complete).toHaveBeenCalledOnce();
      expect(s.component.emit).toHaveBeenCalledExactlyOnceWith("close");
      expect(s.notifications.success).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      s.component.unmount();
    }
  });
});
