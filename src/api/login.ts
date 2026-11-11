import { requestHemusic } from "@/utils/request";
import type { DeviceInfo } from "@/types/main.hemusic";

export const accountLogin = (username: string, password: string, device_info?: DeviceInfo) => {
  return requestHemusic({
    url: "/v1/user/login",
    method: "post",
    data: {
      username,
      password,
      device_info,
    },
  });
};

export const updateUserInfo = (data: { nickname: string; avatar: string }) => {
  return requestHemusic({
    url: "/v1/user/info",
    method: "put",
    data,
  });
};
export const updateUserPassword = (old_password: string, new_password: string) => {
  return requestHemusic({
    url: "/v1/user/password",
    method: "put",
    data: {
      old_password,
      new_password,
    },
  });
};
