<template>
  <div class="login-phone">
    <n-form
      ref="formRef"
      :model="formData"
      :rules="formRules"
      class="phone-form"
      novalidate
      @submit.prevent="login"
      @keydown.capture="handleFormKeydown"
      @keyup.capture="resetKeyboardSubmitGuard"
      @pointerdown.capture="resetKeyboardSubmitGuard"
    >
      <n-form-item :label="t('common.username')" path="username">
        <n-input
          v-model:value="formData.username"
          type="text"
          :show-button="false"
          :placeholder="t('modal.username_placeholder')"
          clearable
          :maxlength="18"
          :minlength="4"
        >
          <template #prefix>
            <SvgIcon name="Phone" :depth="3" />
          </template>
        </n-input>
      </n-form-item>
      <n-form-item :label="t('common.password')" path="password">
        <n-input
          v-model:value="formData.password"
          type="password"
          show-password-on="mousedown"
          :placeholder="t('modal.password_placeholder')"
          :maxlength="18"
          :minlength="6"
          clearable
        >
          <template #prefix>
            <SvgIcon name="Password" :depth="3" />
          </template>
        </n-input>
      </n-form-item>
      <n-form-item :show-label="false">
        <n-button :loading="loading" class="login" type="primary" attr-type="submit">
          {{ t("common.login") }}
        </n-button>
      </n-form-item>
    </n-form>
  </div>
</template>

<script setup lang="ts">
import type { FormInst, FormRules } from "naive-ui";
import axios from "axios";
import { accountLogin } from "@/api/login";
import { useFormRule } from "@/utils/rules";
import { LoginType } from "@/types/main";
import { useI18n } from "vue-i18n";
import { getDeviceInfo } from "@/utils/device";
const { t } = useI18n();
const { passwordRule, usernameRule } = useFormRule();
const emit = defineEmits<{
  saveLogin: [any, LoginType];
}>();
const loading = ref(false);

// 表单类型
interface FormType {
  username: string;
  password: string;
}

// 表单数据
const formRef = ref<FormInst | null>(null);
const formData = ref<FormType>({
  username: "",
  password: "",
});
const formRules = computed<FormRules>(() => ({
  username: usernameRule,
  password: passwordRule,
}));

// 只拦截当前按键引起的提交，保留输入法确认候选词的默认行为
let ignoreKeyboardSubmit = false;
const handleFormKeydown = (event: KeyboardEvent) => {
  ignoreKeyboardSubmit =
    event.key === "Enter" && (event.isComposing || event.keyCode === 229 || event.repeat);
  if (event.key === "Enter" && event.repeat) event.preventDefault();
};
const resetKeyboardSubmitGuard = () => {
  ignoreKeyboardSubmit = false;
};

// 按钮点击和回车共用表单提交入口
const login = async () => {
  if (ignoreKeyboardSubmit || loading.value || !formRef.value) return;
  loading.value = true;
  try {
    try {
      await formRef.value.validate();
    } catch {
      // 校验失败由表单展示字段错误，不发送登录请求
      return;
    }
    const deviceInfo = await getDeviceInfo();
    const loginResult = await accountLogin(
      formData.value.username,
      formData.value.password,
      deviceInfo,
    );
    emit("saveLogin", loginResult, "password");
  } catch (error) {
    if (!axios.isAxiosError(error)) window.$message.error(t("modal.login_failed"));
  } finally {
    loading.value = false;
  }
};
</script>

<style lang="scss" scoped>
.login-phone {
  .phone-form {
    margin-top: 20px;
    .send {
      margin-left: 12px;
    }
    .login {
      width: 100%;
    }
  }
}
</style>
