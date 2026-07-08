<template>
  <div class="update-password">
    <n-form ref="formRef" :model="formData" :rules="formRules" class="n-form">
      <n-form-item :label="t('modal.old_password')" path="old_password">
        <n-input
          v-model:value="formData.old_password"
          type="password"
          show-password-on="mousedown"
          :placeholder="t('modal.old_password_placeholder')"
          :maxlength="18"
          :minlength="6"
          passively-activated
          clearable
        >
          <template #prefix>
            <SvgIcon name="Password" :depth="3" />
          </template>
        </n-input>
      </n-form-item>
      <n-form-item :label="t('modal.new_password')" path="new_password">
        <n-input
          v-model:value="formData.new_password"
          type="password"
          show-password-on="mousedown"
          :placeholder="t('modal.new_password_placeholder')"
          :maxlength="18"
          :minlength="6"
          passively-activated
          clearable
        >
          <template #prefix>
            <SvgIcon name="Password" :depth="3" />
          </template>
        </n-input>
      </n-form-item>
      <n-form-item :label="t('modal.repeat_password')" path="repeat_password">
        <n-input
          v-model:value="formData.repeat_password"
          type="password"
          show-password-on="mousedown"
          :placeholder="t('modal.repeat_password_placeholder')"
          :maxlength="18"
          :minlength="6"
          passively-activated
          clearable
        >
          <template #prefix>
            <SvgIcon name="Password" :depth="3" />
          </template>
        </n-input>
      </n-form-item>
      <n-form-item :show-label="false">
        <n-button class="update" type="primary" @click="updatePassword">
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
import { updateUserPassword } from "@/api/login";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();
const { passwordRule } = useFormRule();

// 表单类型
interface FormType {
  old_password: string;
  new_password: string;
  repeat_password: string;
}

// 表单数据
const formRef = ref<FormInst | null>(null);
const formData = ref<FormType>({
  old_password: "",
  new_password: "",
  repeat_password: "",
});

const formRules = computed<FormRules>(() => ({
  old_password: passwordRule,
  new_password: passwordRule,
  repeat_password: passwordRule,
}));

// 新建歌单
const updatePassword = debounce(
  async (e: MouseEvent) => {
    e.preventDefault();

    await formRef.value?.validate((errors) => errors);
    if (formData.value.new_password !== formData.value.repeat_password) {
      window.$message.error(t("message.repeat_password_not_match"));
      return;
    }

    updateUserPassword(formData.value.old_password, formData.value.new_password).then(() => {
      emit("close");
      window.$message.success(t("message.password_modify_success"));
    });
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
