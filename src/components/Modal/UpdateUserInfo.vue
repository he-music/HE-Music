<template>
  <div class="update-password">
    <n-form ref="formRef" :model="formData" :rules="formRules" class="n-form">
      <n-form-item :label="t('common.nickname')" path="nickname">
        <n-input
          v-model:value="formData.nickname"
          type="text"
          show-password-on="mousedown"
          :placeholder="t('modal.nickname_placeholder')"
          :maxlength="30"
          passively-activated
          clearable
        >
          <template #prefix>
            <SvgIcon name="Person" :depth="3" />
          </template>
        </n-input>
      </n-form-item>
      <n-form-item :label="t('modal.avatar_url')" path="avatar">
        <n-input
          v-model:value="formData.avatar"
          type="text"
          show-password-on="mousedown"
          :placeholder="t('modal.avatar_url_placeholder')"
          :maxlength="255"
          passively-activated
          clearable
        >
          <template #prefix>
            <SvgIcon name="Link" :depth="3" />
          </template>
        </n-input>
      </n-form-item>
      <n-form-item :show-label="false">
        <n-button class="update" type="primary" @click="updateInfo">
          {{ t("common.save") }}
        </n-button>
      </n-form-item>
    </n-form>
  </div>
</template>

<script setup lang="ts">
import type { FormInst, FormRules } from "naive-ui";
import { useFormRule } from "@/utils/rules";
import { debounce } from "lodash-es";
import { updateUserInfo } from "@/api/login";
import { updateUserAccountInfo } from "@/utils/auth";
import { useDataStore } from "@/stores";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const { textRule } = useFormRule();
const emit = defineEmits<{ close: [] }>();

const dataStore = useDataStore();

// 表单类型
interface FormType {
  nickname: string;
  avatar: string;
}

// 表单数据
const formRef = ref<FormInst | null>(null);
const formData = ref<FormType>({
  nickname: dataStore.userData.nickname,
  avatar: dataStore.userData.avatar,
});

const formRules = computed<FormRules>(() => ({
  nickname: textRule,
  avatar: textRule,
}));

// 新建歌单
const updateInfo = debounce(
  async (e: MouseEvent) => {
    e.preventDefault();

    await formRef.value?.validate((errors) => errors);

    updateUserInfo({ nickname: formData.value.nickname, avatar: formData.value.avatar }).then(
      () => {
        updateUserAccountInfo();
        emit("close");
        window.$message.success(t("message.userinfo_modify_success"));
      },
    );
  },
  300,
  { leading: true, trailing: false },
);
</script>

<style lang="scss" scoped>
.update-password {
  .n-form {
    margin-top: 12px;
  }
  .update {
    width: 100%;
  }
  .n-empty {
    padding: 40px 0;
  }
}
</style>
