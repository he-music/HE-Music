import { requestHemusic } from "@/utils/request";

/** 此操作不能自动重放；一次提交的结果不确定时交由用户刷新确认。 */
export const resetProviderIdentity = async (signal?: AbortSignal): Promise<void> => {
  await requestHemusic({
    url: "/v1/user/provider-identity/reset",
    method: "post",
    data: {},
    signal,
    skipAuthRefresh: true,
    skipErrorMessage: true,
  });
};
