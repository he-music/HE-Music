<template>
  <div class="login-qrcode">
    <div class="qr-img">
      <div v-if="qrContent" :class="['qr', { success: qrStatus === 'success' }]">
        <n-qr-code
          :value="qrContent"
          :size="160"
          :icon-size="30"
          icon-src="/icons/favicon.png?asset"
          error-correction-level="H"
        />
      </div>
      <n-skeleton v-else class="qr" />
    </div>
    <n-text class="tip" depth="3">
      {{ qrTipText }}
    </n-text>
    <n-text class="download-tip" depth="3">
      <n-a href="https://github.com/he-music/HE-Music-Flutter" target="_blank">
        <SvgIcon name="Phone" :size="14" />
        {{ t("modal.download_client_tip") }}
      </n-a>
    </n-text>
  </div>
</template>

<script setup lang="ts">
import { createQrLoginSession, exchangeQrLoginResult, getQrLoginSessionStatus } from "@/api/auth";
import { LoginType } from "@/types/main";
import { isElectron, isLinux, isMac, isWin } from "@/utils/env";
import { useI18n } from "vue-i18n";
import { getDeviceInfo } from "@/utils/device";

const { t } = useI18n();

const props = defineProps<{
  pause?: boolean;
}>();

const emit = defineEmits<{
  saveLogin: [any, LoginType];
}>();

type QrLoginStatus =
  | "idle"
  | "creating"
  | "pending"
  | "scanned"
  | "confirmed"
  | "success"
  | "expired"
  | "cancelled"
  | "failure";

const qrCodeTip: Record<QrLoginStatus, string> = {
  idle: "modal.qr_login_idle",
  creating: "modal.qr_login_creating",
  pending: "modal.qr_login_pending",
  scanned: "modal.qr_login_scanned",
  confirmed: "modal.qr_login_confirmed",
  success: "modal.qr_login_success",
  expired: "modal.qr_login_expired",
  cancelled: "modal.qr_login_cancelled",
  failure: "modal.qr_login_failure",
};

const defaultCheckIntervalMs = 2000;
const qrContent = ref("");
const sessionId = ref("");
const resultToken = ref("");
const expireAt = ref(0);
const userHint = ref("");
const checkIntervalMs = ref(defaultCheckIntervalMs);
const qrStatus = ref<QrLoginStatus>("idle");
const isExchanging = ref(false);

let pollTimer: ReturnType<typeof setTimeout> | null = null;

const normalizeQrStatus = (
  status: string | undefined,
  fallback: QrLoginStatus = "failure",
): QrLoginStatus => {
  switch (status) {
    case "pending":
    case "scanned":
    case "confirmed":
    case "success":
    case "expired":
    case "cancelled":
      return status;
    default:
      return fallback;
  }
};

const clearPollTimer = () => {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = null;
};

const scheduleNextPoll = () => {
  clearPollTimer();
  if (props.pause || !sessionId.value) return;
  pollTimer = setTimeout(() => {
    void fetchQrStatus();
  }, checkIntervalMs.value);
};

// 提示文本
const qrTipText = computed(() => {
  const tip = qrCodeTip[qrStatus.value];
  if (tip) return t(tip);
  return userHint.value;
});

const qrClientName = () => {
  if (!isElectron) return "HE Music Web";
  if (isMac) return "HE Music MacOS";
  if (isWin) return "HE Music Windows";
  if (isLinux) return "HE Music Linux";
  return "HE Music Desktop";
};

const refreshQrSession = async () => {
  if (props.pause) return;
  try {
    clearPollTimer();
    qrStatus.value = "creating";
    userHint.value = "";
    const result = await createQrLoginSession({
      client_type: "electron_vue",
      client_name: qrClientName(),
      scene: "desktop_login",
      device_info: await getDeviceInfo(),
    });

    sessionId.value = result.session_id;
    resultToken.value = result.result_token;
    qrContent.value = result.qr_content;
    expireAt.value = result.expires_at;
    checkIntervalMs.value = Math.max(result.check_interval || 2, 1) * 1000;
    qrStatus.value = normalizeQrStatus(result.status, "pending");

    if (qrStatus.value === "confirmed") {
      await exchangeQrResult();
      return;
    }

    if (qrStatus.value === "pending" || qrStatus.value === "scanned") {
      scheduleNextPoll();
    }
  } catch (error) {
    clearPollTimer();
    qrStatus.value = "failure";
    userHint.value = "";
    console.error("二维码获取失败：", error);
    window.$message.error(t("modal.qr_login_create_failed"));
  }
};

const exchangeQrResult = async () => {
  if (!sessionId.value || !resultToken.value || isExchanging.value) return;

  try {
    clearPollTimer();
    isExchanging.value = true;
    qrStatus.value = "confirmed";

    const result = await exchangeQrLoginResult({
      session_id: sessionId.value,
      result_token: resultToken.value,
    });

    qrStatus.value = normalizeQrStatus(result.status, "failure");
    expireAt.value = result.expires_at;
    userHint.value = "";

    if (result.status === "success" && result.access_token) {
      qrStatus.value = "success";
      emit(
        "saveLogin",
        {
          token: result.access_token,
          refresh_token: result.refresh_token,
          expires_at: result.expires_at,
        },
        "qr",
      );
      return;
    }

    if (qrStatus.value === "pending" || qrStatus.value === "scanned") {
      scheduleNextPoll();
      return;
    }

    if (qrStatus.value === "expired" || qrStatus.value === "cancelled") {
      await refreshQrSession();
      return;
    }

    qrStatus.value = "failure";
    window.$message.error(t("modal.qr_login_exchange_failed"));
  } catch (error) {
    qrStatus.value = "failure";
    console.error("二维码登录结果兑换失败：", error);
    window.$message.error(t("modal.qr_login_exchange_failed"));
  } finally {
    isExchanging.value = false;
  }
};

const fetchQrStatus = async () => {
  if (!sessionId.value || props.pause) return;

  try {
    const result = await getQrLoginSessionStatus(sessionId.value);
    qrStatus.value = normalizeQrStatus(result.status, "pending");
    userHint.value = result.user_hint || "";
    expireAt.value = result.expires_at;
    checkIntervalMs.value = Math.max(result.check_interval || 2, 1) * 1000;

    if (qrStatus.value === "confirmed") {
      await exchangeQrResult();
      return;
    }

    if (qrStatus.value === "pending" || qrStatus.value === "scanned") {
      scheduleNextPoll();
      return;
    }

    if (qrStatus.value === "expired" || qrStatus.value === "cancelled") {
      await refreshQrSession();
      return;
    }
  } catch (error) {
    clearPollTimer();
    qrStatus.value = "failure";
    console.error("二维码状态检查失败：", error);
    window.$message.error(t("modal.qr_login_status_failed"));
  }
};

watch(
  () => props.pause,
  (pause) => {
    if (pause) {
      clearPollTimer();
      return;
    }

    if (sessionId.value && (qrStatus.value === "pending" || qrStatus.value === "scanned")) {
      scheduleNextPoll();
      return;
    }

    if (
      !sessionId.value ||
      qrStatus.value === "idle" ||
      qrStatus.value === "expired" ||
      qrStatus.value === "cancelled" ||
      qrStatus.value === "failure"
    ) {
      void refreshQrSession();
    }
  },
  { immediate: false },
);

onMounted(() => {
  void refreshQrSession();
});

onBeforeUnmount(() => {
  clearPollTimer();
});
</script>

<style lang="scss" scoped>
.login-qrcode {
  display: flex;
  flex-direction: column;
  align-items: center;
  .qr-img {
    display: flex;
    margin: 9px 0;
    width: 172px;
    height: 172px;
    border-radius: 12px;
    overflow: hidden;
    .qr {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      .n-qr-code {
        padding: 0;
        height: 180px;
        width: 180px;
        min-height: 180px;
        min-width: 180px;
        transition:
          opacity 0.3s,
          filter 0.3s;
        :deep(canvas) {
          width: 100% !important;
          height: 100% !important;
        }
      }
      &.success {
        .n-qr-code {
          opacity: 0.5;
          filter: blur(4px);
        }
      }
    }
  }
  .tip {
    margin-bottom: 12px;
  }
  .download-tip {
    font-size: 12px;
    a {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      text-decoration: none;
      &:hover {
        text-decoration: underline;
      }
    }
  }
}
</style>
