<template>
  <div class="captcha" :class="{ 'captcha--image': method === CAPTCHA_METHOD_IMAGE }">
    <div v-if="method === CAPTCHA_METHOD_CAP" class="cap-wrapper">
      <component
        :is="'cap-widget'"
        ref="widgetElement"
        :data-cap-api-endpoint="capEndpoint"
        :data-cap-lang="capLanguage"
      />
      <n-button v-if="canSwitchToImage" text type="primary" @click="switchToImage">
        {{ t("message.captcha_use_image") }}
      </n-button>
      <n-button v-if="needsReverify" text type="primary" @click="reverify">
        {{ t("message.captcha_reverify") }}
      </n-button>
    </div>
    <template v-else>
      <Click
        v-if="data.type === 1 || data.type === 2"
        :data="data"
        :config="clickConfig"
        :events="{ refresh, confirm: clickConfirm }"
      />
      <Slide
        v-else-if="data.type === 4"
        :data="data"
        :config="slideConfig"
        :events="{ refresh, confirm: slideConfirm }"
      />
      <SlideRegion
        v-else-if="data.type === 3"
        :data="data"
        :config="slideRegionConfig"
        :events="{ refresh, confirm: slideConfirm }"
      />
      <Rotate
        v-else-if="data.type === 5"
        :data="data"
        :config="rotateConfig"
        :events="{ refresh, confirm: rotateConfirm }"
      />
      <div class="loading" v-if="loading"><n-spin size="large" /></div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { Click, Rotate, Slide, SlideRegion } from "go-captcha-vue";
import {
  CAPTCHA_METHOD_CAP,
  CAPTCHA_METHOD_IMAGE,
  createCaptchaSession,
  getCaptchaImage,
  getCaptchaResult,
  redeemCapCaptcha,
  switchCaptchaMethod,
  verifyCaptcha,
} from "@/api/captcha";
import { API_URL } from "@/utils/request";
import { useSettingStore } from "@/stores";
import { createCaptchaFetch } from "@/utils/captchaFetch";
import { debounce } from "lodash-es";
import { useI18n } from "vue-i18n";
import "go-captcha-vue/dist/style.css";
import "@cap.js/widget";

const { t } = useI18n();
const settingStore = useSettingStore();
const capLanguage = computed(() => settingStore.language);
const clickConfig = computed(() => ({
  title: t("modal.captcha_click_title"),
  buttonText: t("modal.captcha_confirm"),
}));
const slideConfig = computed(() => ({ title: t("modal.captcha_slide_title") }));
const slideRegionConfig = computed(() => ({ title: t("modal.captcha_slide_region_title") }));
const rotateConfig = computed(() => ({ title: t("modal.captcha_rotate_title") }));
const props = defineProps<{ scene: number; meta: string }>();
const emit = defineEmits<{ success: [captchaTicket: string]; close: [] }>();

interface CaptchaDataType {
  challenge_id: string;
  thumbX: number;
  thumbY: number;
  thumbWidth: number;
  thumbHeight: number;
  thumbSize: number;
  image: string;
  thumb: string;
  type: number;
}

const data = ref<CaptchaDataType>({
  challenge_id: "",
  thumbX: 0,
  thumbY: 0,
  thumbWidth: 0,
  thumbHeight: 0,
  thumbSize: 0,
  image: "",
  thumb: "",
  type: 0,
});
const sessionId = ref("");
const method = ref(CAPTCHA_METHOD_CAP);
const capEndpoint = ref("");
const loading = ref(true);
const canSwitchToImage = ref(false);
const needsReverify = ref(false);
const widgetElement = ref<HTMLElement | null>(null);
let switchTimer: ReturnType<typeof setTimeout> | undefined;
let successTimer: ReturnType<typeof setTimeout> | undefined;
let solvedAt = 0;
let redeeming = false;
let successScheduled = false;
let active = true;
let previousFetch: typeof window.CAP_CUSTOM_FETCH;
let boundFetch: typeof window.CAP_CUSTOM_FETCH;

const showError = (message: string) => window.$message.error(message);

const bindCaptchaFetch = (activeSessionId: string) => {
  previousFetch = window.CAP_CUSTOM_FETCH;
  boundFetch = createCaptchaFetch(activeSessionId, previousFetch);
  window.CAP_CUSTOM_FETCH = boundFetch;
};

const clearCaptchaFetch = () => {
  if (window.CAP_CUSTOM_FETCH === boundFetch) window.CAP_CUSTOM_FETCH = previousFetch;
};

const loadImage = async () => {
  loading.value = true;
  try {
    const image = await getCaptchaImage(props.scene, props.meta, sessionId.value);
    data.value = {
      ...image,
      thumbX: image.thumb_x,
      thumbY: image.thumb_y,
      thumbWidth: image.thumb_width,
      thumbHeight: image.thumb_height,
      thumbSize: image.thumb_size,
    };
  } catch (error) {
    showError(error instanceof Error ? error.message : t("message.captcha_fail"));
  } finally {
    loading.value = false;
  }
};

const switchToImage = async () => {
  if (!sessionId.value) return;
  loading.value = true;
  try {
    await switchCaptchaMethod(sessionId.value);
    clearCaptchaFetch();
    method.value = CAPTCHA_METHOD_IMAGE;
    canSwitchToImage.value = false;
    if (switchTimer) clearTimeout(switchTimer);
    await loadImage();
  } catch (error) {
    loading.value = false;
    showError(error instanceof Error ? error.message : t("message.captcha_fail"));
  }
};

const initialize = async () => {
  clearCaptchaFetch();
  loading.value = true;
  canSwitchToImage.value = false;
  needsReverify.value = false;
  try {
    const session = await createCaptchaSession(props.scene, props.meta);
    sessionId.value = session.session_id;
    method.value = session.method;
    if (session.method === CAPTCHA_METHOD_CAP) {
      const endpoint = session.cap_endpoint || "/v1/captcha/";
      capEndpoint.value = new URL(endpoint, API_URL).toString();
      bindCaptchaFetch(session.session_id);
      switchTimer = setTimeout(() => (canSwitchToImage.value = true), 10_000);
    } else {
      await loadImage();
    }
  } catch (error) {
    canSwitchToImage.value = true;
    needsReverify.value = true;
    showError(error instanceof Error ? error.message : t("message.captcha_fail"));
  } finally {
    loading.value = false;
  }
};

const recoverCapResult = async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await getCaptchaResult(sessionId.value);
      if (result.is_success && result.captcha_ticket) return result.captcha_ticket;
      if (result.reason !== "CAPTCHA_RESULT_PENDING") return null;
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
};

const solveCap = async (event: Event) => {
  const token = (event as CustomEvent<{ token: string }>).detail?.token;
  if (!token || !sessionId.value || redeeming || successScheduled || !active) return;
  redeeming = true;
  solvedAt = performance.now();
  const complete = (ticket: string) => {
    if (!active) return;
    successScheduled = true;
    const remaining = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : Math.max(0, 550 - (performance.now() - solvedAt));
    successTimer = setTimeout(() => {
      if (active) emit("success", ticket);
    }, remaining);
  };
  try {
    const result = await redeemCapCaptcha(props.scene, props.meta, sessionId.value, token);
    if (result.is_success && result.captcha_ticket) complete(result.captcha_ticket);
    else showError(t("message.captcha_fail"));
  } catch (error) {
    if (!(error as { response?: unknown }).response) {
      const ticket = await recoverCapResult();
      if (ticket) {
        complete(ticket);
        return;
      }
    }
    if (
      (error as { response?: { data?: { reason?: string } } }).response?.data?.reason ===
      "CAPTCHA_SESSION_EXPIRED"
    ) {
      needsReverify.value = true;
    }
    showError(error instanceof Error ? error.message : t("message.captcha_fail"));
  } finally {
    redeeming = false;
  }
};

const reverify = () => {
  void initialize();
};

const verify = debounce(
  async (angle: number, point: object, dots: object[], reset: () => void) => {
    try {
      const result = await verifyCaptcha(
        props.scene,
        props.meta,
        sessionId.value,
        data.value.challenge_id,
        angle,
        point,
        dots,
      );
      if (result.is_success && result.captcha_ticket) emit("success", result.captcha_ticket);
      else {
        showError(
          result.reason === "CAPTCHA_SESSION_EXPIRED"
            ? t("message.captcha_expired")
            : t("message.captcha_fail"),
        );
        reset();
        await loadImage();
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : t("message.captcha_fail"));
      reset();
    }
  },
  300,
  { leading: true, trailing: false },
);

const clickConfirm = (dots: Array<{ x: number; y: number }>, reset: () => void) =>
  verify(
    0,
    {},
    dots.map((item) => ({ x: item.x, y: item.y })),
    reset,
  );
const rotateConfirm = (angle: number, reset: () => void) => verify(angle, {}, [], reset);
const slideConfirm = (point: object, reset: () => void) => verify(0, point, [], reset);
const refresh = () => loadImage();

onMounted(async () => {
  const widget = widgetElement.value;
  widget?.addEventListener("solve", solveCap);
  widget?.addEventListener("error", () => (canSwitchToImage.value = true));
  await initialize();
});

onBeforeUnmount(() => {
  active = false;
  if (switchTimer) clearTimeout(switchTimer);
  if (successTimer) clearTimeout(successTimer);
  clearCaptchaFetch();
  widgetElement.value?.removeEventListener("solve", solveCap);
  verify.cancel();
});
</script>

<style lang="scss" scoped>
.captcha {
  position: relative;
}

.captcha--image {
  min-height: 150px;
}

.cap-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.2);
}
</style>
