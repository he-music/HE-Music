<template>
  <div class="login" :aria-busy="oauthPending">
    <Logo :size="60" class="logo" />
    <!-- 登录方式 -->
    <n-tabs
      v-show="!oauthPending"
      class="login-tabs"
      v-model:value="activeTab"
      type="segment"
      animated
    >
      <n-tab-pane
        name="login-password"
        :tab="t('modal.login_password_tab')"
        display-directive="show:lazy"
      >
        <LoginPassword
          :pause="activeTab !== 'login-password' || closed || oauthPending"
          @save-login="saveLogin"
        />
      </n-tab-pane>
      <n-tab-pane name="login-qr" :tab="t('modal.login_qr_tab')" display-directive="show:lazy">
        <LoginQRCode
          :pause="activeTab !== 'login-qr' || closed || oauthPending"
          @save-login="saveLogin"
        />
      </n-tab-pane>
    </n-tabs>

    <n-flex v-if="oauthPending" class="oauth-pending" align="center" justify="center" vertical>
      <n-spin size="medium" />
      <n-text role="status" aria-live="polite">
        {{ t("modal.oauth_waiting", { provider: oauthProvider }) }}
      </n-text>
    </n-flex>

    <!-- 其他方式 -->
    <n-flex v-show="!oauthPending" align="center" class="other">
      <n-button
        v-for="item in providers"
        :key="item"
        text
        style="font-size: 16px"
        :disabled="oauthPending"
        @click="oauthLogin(item)"
      >
        <template #icon>
          <SvgIcon size="20" :name="item" />
        </template>
        {{ item }}
      </n-button>
    </n-flex>
    <!-- 关闭登录 -->
    <n-button
      :focusable="false"
      class="close"
      strong
      secondary
      round
      @click="oauthPending ? cancelOAuth() : closeLogin()"
    >
      <template #icon>
        <SvgIcon name="WindowClose" />
      </template>
      {{ t(oauthPending ? "modal.oauth_cancel" : "common.cancel") }}
    </n-button>
  </div>
</template>

<script setup lang="ts">
import { completeLogin, type LoginResult } from "@/utils/login";
import { useDataStore } from "@/stores";
import LoginPassword from "@/components/Modal/Login/LoginPassword.vue";
import Logo from "@/components/Layout/Logo.vue";
import { useI18n } from "vue-i18n";
import { createAuthSession, authProviders } from "@/api/auth";
import SvgIcon from "@/components/Global/SvgIcon.vue";
import { getDeviceInfo } from "@/utils/device";
import { createDesktopOAuth } from "@/platform/auth";
import { platform } from "@/platform";

const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();
const dataStore = useDataStore();
const providers = ref<string[]>([]);
const activeTab = ref("login-password");
const closed = ref(false);
const oauthPending = ref(false);
const oauthProvider = ref("");
let webAttempt = 0;
let accepted = false;
const loginFailed = () => window.$message.error(t("modal.login_failed"));
const saveLogin = async (result: LoginResult) => {
  if (closed.value || accepted) return;
  accepted = true;
  cancelOAuth();
  try {
    // completeLogin 在第一次 await 前同步接受凭据；随后关闭引发卸载不会丢弃结果。
    const completion = completeLogin(result);
    closed.value = true;
    emit("close");
    await completion;
    window.$message.success(t("modal.login_success"));
  } catch {
    loginFailed();
  }
};
const desktopOAuth = createDesktopOAuth(saveLogin, loginFailed, (pending) => {
  oauthPending.value = pending;
  if (!pending) oauthProvider.value = "";
});
const cancelOAuth = () => {
  webAttempt++;
  desktopOAuth.cancel();
  oauthPending.value = false;
  oauthProvider.value = "";
};
const closeLogin = () => {
  closed.value = true;
  cancelOAuth();
  emit("close");
};
const oauthLogin = async (provider: string) => {
  if (closed.value || accepted || oauthPending.value) return;
  cancelOAuth();
  oauthProvider.value = provider;
  oauthPending.value = true;
  if (platform.kind !== "web") {
    await desktopOAuth.start(provider);
    return;
  }
  const attempt = ++webAttempt;
  try {
    const device_info = await getDeviceInfo();
    if (closed.value || attempt !== webAttempt) return;
    const { url } = await createAuthSession({
      provider,
      redirect_uri: window.location.origin,
      device_info,
    });
    if (closed.value || attempt !== webAttempt) return;
    window.location.href = url;
  } catch {
    if (!closed.value && attempt === webAttempt) {
      cancelOAuth();
      loginFailed();
    }
  }
};
watch(
  activeTab,
  () => {
    cancelOAuth();
  },
  { flush: "sync" },
);
onMounted(() => {
  void authProviders()
    .then((res) => {
      if (!closed.value) providers.value = res.list;
    })
    .catch(() => {
      if (!closed.value) loginFailed();
    });
});
onBeforeUnmount(() => {
  closed.value = true;
  cancelOAuth();
});
onBeforeMount(() => {
  if (dataStore.userLoginStatus) {
    window.$message.warning(t("modal.already_login"));
    closeLogin();
  }
});
</script>

<style lang="scss" scoped>
.login {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  .logo {
    width: 60px;
    height: 60px;
    margin: 20px auto 30px auto;
  }
  .oauth-pending {
    min-height: 240px;
    padding: 24px 0;
    text-align: center;
  }
  .other {
    margin: 10px;
    .n-button {
      width: 140px;
    }
  }
  .close {
    margin-bottom: 8px;
  }
}
</style>
