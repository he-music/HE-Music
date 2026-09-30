import { requestHemusic } from "@/utils/request";

export const CAPTCHA_METHOD_IMAGE = 1;
export const CAPTCHA_METHOD_CAP = 2;

export interface CaptchaSession {
  method: number;
  session_id: string;
  expires_at: number;
  cap_endpoint?: string;
}

export interface CaptchaImage {
  challenge_id: string;
  thumb_x: number;
  thumb_y: number;
  thumb_width: number;
  thumb_height: number;
  thumb_size: number;
  image: string;
  thumb: string;
  type: number;
}

export interface CaptchaTicket {
  is_success: boolean;
  captcha_ticket?: string;
  expires_at?: number;
  reason?: string;
}

const buildCaptchaUrl = (scene: number, meta: string, sessionId?: string) => {
  const params = new URLSearchParams({ scene: String(scene), meta });
  if (sessionId) params.set("session_id", sessionId);
  return `/v1/captcha?${params.toString()}`;
};

export const createCaptchaSession = (scene: number, meta: string) => {
  const params = new URLSearchParams({ scene: String(scene), meta });
  params.append("supported_methods", "CAPTCHA_METHOD_CAP");
  params.append("supported_methods", "CAPTCHA_METHOD_IMAGE");
  return requestHemusic({
    url: `/v1/captcha?${params.toString()}`,
    method: "get",
  }) as Promise<CaptchaSession>;
};

export const getCaptchaImage = (scene: number, meta: string, sessionId: string) => {
  return requestHemusic({
    url: buildCaptchaUrl(scene, meta, sessionId),
    method: "get",
  }) as Promise<CaptchaImage>;
};

export const switchCaptchaMethod = (sessionId: string) => {
  return requestHemusic({
    url: "/v1/captcha/switch",
    method: "post",
    data: { session_id: sessionId },
  }) as Promise<{ method: number }>;
};

export const verifyCaptcha = (
  scene: number,
  meta: string,
  sessionId: string,
  challengeId: string,
  angle: number = 0,
  point: object = {},
  dots: object[] = [],
) => {
  return requestHemusic({
    url: "/v1/captcha",
    method: "post",
    data: {
      scene,
      meta,
      session_id: sessionId,
      challenge_id: challengeId,
      angle,
      point,
      dots,
    },
  }) as Promise<CaptchaTicket>;
};

export const redeemCapCaptcha = (
  scene: number,
  meta: string,
  sessionId: string,
  capToken: string,
) => {
  return requestHemusic({
    url: "/v1/captcha",
    method: "post",
    data: { scene, meta, session_id: sessionId, cap_token: capToken },
  }) as Promise<CaptchaTicket>;
};

export const getCaptchaResult = (sessionId: string) => {
  return requestHemusic({
    url: "/v1/captcha/result",
    method: "post",
    data: { session_id: sessionId },
  }) as Promise<CaptchaTicket>;
};
