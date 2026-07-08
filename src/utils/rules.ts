import type { FormItemRule } from "naive-ui";
import { useI18n } from "vue-i18n";
export function useFormRule() {
  const { t } = useI18n();

  // 普通文本
  const textRule: FormItemRule = {
    required: true,
    message: t("rule.required"),
    trigger: ["blur"],
  };
  const numberRule: FormItemRule = {
    required: true,
    type: "number",
    message: t("rule.number_required"),
    trigger: ["input", "blur"],
  };

  const emailRule: FormItemRule = {
    required: true,
    message: t("rule.email_required"),
    trigger: ["input", "blur"],
    validator: (_: FormItemRule, value: any) => {
      if (!value) return new Error(t("rule.email_required"));
      else if (
        !/^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(
          value,
        )
      ) {
        return new Error(t("rule.email_invalid"));
      }
      return true;
    },
  };
  const phoneRule: FormItemRule = {
    required: true,
    type: "number",
    message: t("rule.phone_required"),
    trigger: ["input", "blur"],
    validator: (_: FormItemRule, value: any) => {
      if (!value) return new Error(t("rule.phone_required"));
      else if (!/^1(3\d|4[5-9]|5[0-35-9]|6[567]|7[0-8]|8\d|9[0-35-9])\d{8}$/.test(value)) {
        return new Error(t("rule.phone_invalid"));
      }
      return true;
    },
  };
  const passwordRule: FormItemRule = {
    required: true,
    type: "string",
    message: t("rule.password_required"),
    trigger: ["input", "blur"],
    validator: (_: FormItemRule, value: any) => {
      if (!value) return new Error(t("rule.password_required"));
      else if (value.length < 6 || value.length > 18) {
        return new Error(t("rule.password_length_invalid"));
      }
      return true;
    },
  };

  const usernameRule: FormItemRule = {
    required: true,
    type: "string",
    message: t("rule.username_required"),
    trigger: ["input", "blur"],
    validator: (_: FormItemRule, value: any) => {
      if (!value) return new Error(t("rule.username_required"));
      else if (value.length < 4 || value.length > 18) {
        return new Error(t("rule.username_length_invalid"));
      }
      if (!/^[0-9a-zA-Z_]{4,18}$/.test(value)) {
        return new Error(t("rule.username_format_invalid"));
      }
      return true;
    },
  };

  return {
    textRule,
    numberRule,
    emailRule,
    phoneRule,
    passwordRule,
    usernameRule,
  };
}
