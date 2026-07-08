<template>
  <div class="login-phone">
    <n-form ref="formRef" :model="formData" :rules="formRules" class="phone-form">
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
        <n-button :loading="loading" class="login" type="primary" @click.stop="login">
          {{ t("common.login") }}
        </n-button>
      </n-form-item>
    </n-form>
  </div>
</template>

<script setup lang="ts">
import type { FormInst, FormRules } from "naive-ui";
import { accountLogin } from "@/api/login";
import { useFormRule } from "@/utils/rules";
import { debounce } from "lodash-es";
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

// 登录
const login = debounce(async (e: MouseEvent) => {
  e.preventDefault();
  // 验证输入
  await formRef.value?.validate();

  if (loading.value) return;
  loading.value = true;
  // 登录
  accountLogin(
    formData.value.username as string,
    formData.value.password as string,
    await getDeviceInfo(),
  )
    .then((loginResult) => {
      emit("saveLogin", loginResult, "password");
    })
    .finally(() => {
      loading.value = false;
    });

  // if (loginResult.code !== 200) {
  //   window.$message.error("登录失败，请重试");
  //   return;
  // }
  // 是否含有 MUSIC_U
  // if (loginResult.cookie && loginResult.cookie.includes("MUSIC_U")) {
  //   // 去除 HTTPOnly
  //   loginResult.cookie = loginResult.cookie.replaceAll(" HTTPOnly", "");
  //   // 储存登录信息
  //   emit("saveLogin", loginResult, "phone");
  // } else {
  //   window.$message.error("登录出错，请重试");
  // }
}, 300);
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
