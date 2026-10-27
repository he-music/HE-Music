<template>
  <div class="login">
    <Logo :size="60" class="logo" />
    <!-- 登录方式 -->
    <n-tabs class="login-tabs" v-model:value="activeTab" type="segment" animated>
      <n-tab-pane
        name="login-password"
        :tab="t('modal.login_password_tab')"
        display-directive="show:lazy"
      >
        <LoginPassword :pause="activeTab !== 'login-password' || closed" @save-login="saveLogin" />
      </n-tab-pane>
      <n-tab-pane name="login-qr" :tab="t('modal.login_qr_tab')" display-directive="show:lazy">
        <LoginQRCode :pause="activeTab !== 'login-qr' || closed" @save-login="saveLogin" />
      </n-tab-pane>
    </n-tabs>

    <!-- 其他方式 -->
    <n-flex align="center" class="other">
      <n-button
        v-for="item in providers"
        :key="item"
        text
        style="font-size: 16px"
        @click="oauthLogin(item)"
      >
        <template #icon>
          <SvgIcon size="20" :name="item" />
        </template>
        {{ item }}
      </n-button>
    </n-flex>
    <!-- 关闭登录 -->
    <n-button :focusable="false" class="close" strong secondary round @click="closeLogin">
      <template #icon>
        <SvgIcon name="WindowClose" />
      </template>
      {{ t("common.cancel") }}
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
let webAttempt = 0;
let accepted = false;
const loginFailed = () => window.$message.error(t("modal.login_failed"));
const saveLogin = async (result: LoginResult) => {
  if (closed.value || accepted) return;
  accepted = true;
  desktopOAuth.cancel();
  webAttempt++;
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
const desktopOAuth = createDesktopOAuth(saveLogin, loginFailed);
const closeLogin = () => {
  closed.value = true;
  webAttempt++;
  desktopOAuth.cancel();
  emit("close");
};
const oauthLogin = async (provider: string) => {
  activeTab.value = "login-password";
  if (closed.value || accepted) return;
  webAttempt++;
  desktopOAuth.cancel();
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
    if (!closed.value && attempt === webAttempt) loginFailed();
  }
};
watch(
  activeTab,
  () => {
    webAttempt++;
    desktopOAuth.cancel();
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
  webAttempt++;
  desktopOAuth.cancel();
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
