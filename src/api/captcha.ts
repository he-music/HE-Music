import { requestHemusic } from "@/utils/request";

// 获取验证码
export const getCaptcha = (type: number, scene: number, meta: string) => {
  return requestHemusic({
    url: "/v1/captcha",
    method: "get",
    params: { type, scene, meta },
  });
};

// 验证验证码
export const verifyCaptcha = (
  scene: number,
  meta: string,
  angle: number = 0,
  point: object = {},
  dots: object[] = [],
) => {
  return requestHemusic({
    url: "/v1/captcha",
    method: "post",
    data: { scene, meta, angle, point, dots },
  });
};
