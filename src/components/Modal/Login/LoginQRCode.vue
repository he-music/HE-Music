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
      <n-a :href="MOBILE_APP_RELEASE_URL" target="_blank">
        <SvgIcon name="Phone" :size="14" />
        {{ t("modal.download_client_tip") }}
      </n-a>
    </n-text>
  </div>
</template>

<script setup lang="ts">
import { createQrLoginSession, exchangeQrLoginResult, getQrLoginSessionStatus } from "@/api/auth";
import type { LoginResult } from "@/utils/login";
import { createQrLoginFlow, type QrLoginStatus, type QrLoginView } from "@/utils/qrLogin";
import { platform } from "@/platform";
import { useI18n } from "vue-i18n";
import { getDeviceInfo } from "@/utils/device";
import { MOBILE_APP_RELEASE_URL } from "@/constants/links";

const { t } = useI18n();
const props = defineProps<{ pause?: boolean }>();
const emit = defineEmits<{ saveLogin: [LoginResult] }>();
const view = shallowRef<QrLoginView>({ content: "", status: "idle" });
const qrContent = computed(() => view.value.content);
const qrStatus = computed(() => view.value.status);
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
const qrTipText = computed(() => t(qrCodeTip[qrStatus.value]));
const qrClientName = () => {
  if (platform.kind === "web") return "HE Music Web";
  if (platform.os === "darwin") return "HE Music MacOS";
  if (platform.os === "win32") return "HE Music Windows";
  if (platform.os === "linux") return "HE Music Linux";
  return "HE Music Desktop";
};
const flow = createQrLoginFlow({
  async create() {
    // 后端兼容字段：未确认后端支持 mygo 的 client_type 枚举。
    return createQrLoginSession({
      client_type: "electron_vue",
      client_name: qrClientName(),
      scene: "desktop_login",
      device_info: await getDeviceInfo(),
    });
  },
  status: getQrLoginSessionStatus,
  exchange: (session_id, result_token) => exchangeQrLoginResult({ session_id, result_token }),
  update: (next) => {
    view.value = next;
  },
  accept: (result) => emit("saveLogin", result),
  onError: (key) => window.$message.error(t(key)),
});
watch(
  () => props.pause,
  (pause) => {
    if (pause) flow.stop();
    else void flow.start();
  },
);
onMounted(() => {
  if (!props.pause) void flow.start();
});
onBeforeUnmount(flow.stop);
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
