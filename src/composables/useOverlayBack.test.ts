import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import { useOverlayBack } from "./useOverlayBack";

const state = vi.hoisted(() => ({
  mobile: undefined as ReturnType<typeof ref<boolean>> | undefined,
  add: vi.fn<(close: () => void) => () => void>(),
}));
vi.mock("./useMobile", () => ({ useMobile: () => ({ isMobilePlayer: state.mobile }) }));
vi.mock("@/utils/overlayHistory", () => ({ getOverlayHistory: () => ({ add: state.add }) }));
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.clearAllMocks();
});

function mount(mobile = true) {
  state.mobile = ref(mobile);
  const visible = ref(false);
  const close = vi.fn(() => {
    visible.value = false;
  });
  const release = vi.fn();
  state.add.mockReturnValue(release);
  const scope = effectScope();
  scopes.push(scope);
  scope.run(() => useOverlayBack(visible, close));
  return { visible, close, release, scope };
}

describe("临时界面返回订阅", () => {
  it("打开时注册，系统返回关闭后释放，卸载不保留订阅", () => {
    const view = mount();
    expect(state.add).not.toHaveBeenCalled();
    view.visible.value = true;
    expect(state.add).toHaveBeenCalledWith(view.close);
    state.add.mock.calls[0][0]();
    expect(view.visible.value).toBe(false);
    expect(view.release).toHaveBeenCalledOnce();
    view.visible.value = true;
    view.scope.stop();
    expect(view.release).toHaveBeenCalledTimes(2);
    view.visible.value = false;
    expect(view.release).toHaveBeenCalledTimes(2);
  });

  it("桌面布局不接管返回，切换到移动布局后按可见状态接入", () => {
    const view = mount(false);
    view.visible.value = true;
    expect(state.add).not.toHaveBeenCalled();
    state.mobile!.value = true;
    expect(state.add).toHaveBeenCalledWith(view.close);
    state.mobile!.value = false;
    expect(view.release).toHaveBeenCalledOnce();
  });
});
