import { afterEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";
import * as resetFlow from "@/composables/recommendationIdentityReset";
import locale from "@/i18n/locales/recommendationIdentityReset.zh-CN.json";

type Confirmation = {
  title: string;
  content: string;
  positiveText: string;
  positiveButtonProps: { loading: boolean; disabled: boolean };
  negativeButtonProps: { disabled: boolean };
  onPositiveClick: () => Promise<void>;
  onAfterLeave: () => void;
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});
function mount() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const reset = vi.fn<(signal: AbortSignal) => Promise<void>>(() => promise);
  const dataStore = reactive({ userLoginStatus: true, userData: { id: "account-a" } });
  const success = vi.fn();
  const error = vi.fn();
  const destroy = vi.fn();
  const confirmations: Confirmation[] = [];
  const warning = vi.fn((options: Confirmation) => {
    confirmations.push(options);
    return { destroy };
  });
  vi.stubGlobal("window", { $dialog: { warning }, $message: { success, error } });
  const messages: Record<string, string> = Object.fromEntries(
    Object.entries(locale.recommendation_identity).map(([key, value]) => [
      `recommendation_identity.${key}`,
      value,
    ]),
  );
  const page = mountProductionSfc(
    new URL("./RecommendationIdentityReset.vue", import.meta.url),
    {
      "vue-i18n": { useI18n: () => ({ t: (key: string) => messages[key] ?? key }) },
      "@/api/providerIdentity": { resetProviderIdentity: reset },
      "@/stores": { useDataStore: () => dataStore },
      "@/composables/recommendationIdentityReset": resetFlow,
    },
    ["NButton"],
  );
  cleanups.push(page.close);
  const button = () => {
    const node = page.all().find((node) => node.tag === "NButton");
    if (!node) throw new Error("missing reset button");
    return node;
  };
  const click = () => emitHostEvent(button(), "onClick");
  return {
    ...page,
    button,
    click,
    reset,
    confirmations,
    warning,
    resolve,
    reject,
    success,
    error,
    dataStore,
    destroy,
  };
}

describe("推荐标识重置真实组件", () => {
  it("仅确认后提交，loading 防重复并在成功时给出准确反馈", async () => {
    const f = mount();
    f.click();
    f.click();
    expect(f.warning).toHaveBeenCalledOnce();
    expect(f.reset).not.toHaveBeenCalled();
    const confirmation = f.confirmations[0];
    expect(confirmation.title).toBe("重置推荐标识？");
    expect(confirmation.content).toBe(locale.recommendation_identity.confirm_content);
    expect(confirmation.positiveText).toBe("确认重置");
    const first = confirmation.onPositiveClick();
    await flushSfcHost();
    expect(f.button().props.loading).toBe(true);
    expect(f.button().props.disabled).toBe(true);
    expect(confirmation.positiveButtonProps.loading).toBe(true);
    expect(confirmation.positiveButtonProps.disabled).toBe(true);
    expect(confirmation.negativeButtonProps.disabled).toBe(true);
    await confirmation.onPositiveClick();
    expect(f.reset).toHaveBeenCalledOnce();
    f.resolve();
    await first;
    await flushSfcHost();
    expect(f.button().props.loading).toBe(false);
    expect(f.success).toHaveBeenCalledExactlyOnceWith("推荐标识已重置，请刷新页面以更新推荐内容");
  });
  it("取消确认不请求，网络错误恢复按钮且只提示结果未知", async () => {
    const f = mount();
    f.click();
    f.confirmations[0].onAfterLeave();
    expect(f.reset).not.toHaveBeenCalled();
    f.click();
    const pending = f.confirmations[1].onPositiveClick();
    f.reject(new TypeError("Network Error"));
    await pending;
    await flushSfcHost();
    expect(f.error).toHaveBeenCalledExactlyOnceWith("未能确认重置结果，请稍后刷新");
    expect(f.button().props.loading).toBe(false);
    expect(f.reset).toHaveBeenCalledOnce();
  });
  it("确认期间切换账号会关闭旧弹窗，旧确认不能重置新账号", async () => {
    const f = mount();
    f.click();
    f.dataStore.userData.id = "account-b";
    expect(f.destroy).toHaveBeenCalledOnce();
    await f.confirmations[0].onPositiveClick();
    expect(f.reset).not.toHaveBeenCalled();
  });
  it("卸载撤销进行中的请求，迟到成功不会显示成功提示", async () => {
    const f = mount();
    f.click();
    const pending = f.confirmations[0].onPositiveClick();
    f.close();
    expect(f.reset.mock.calls[0][0].aborted).toBe(true);
    f.resolve();
    await pending;
    expect(f.success).not.toHaveBeenCalled();
  });
});
