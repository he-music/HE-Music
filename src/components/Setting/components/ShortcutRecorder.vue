<template>
  <n-flex :wrap="false" align="center" style="width: 460px; justify-content: flex-end">
    <!-- 本地/页面内快捷键 -->
    <n-input
      ref="localInput"
      :value="shortcutItem.shortcut"
      :placeholder="t('setting.shortcut.shortcut_placeholder')"
      readonly
      class="shortcut-input"
      @focus="onFocus(false)"
      @blur="onBlur"
      @keydown.stop="onKeyDown"
      @keyup="keyHandled = ''"
    />
    <!-- 全局快捷键 -->
    <n-input
      ref="globalInput"
      v-if="allowGlobal"
      :value="shortcutItem.globalShortcut"
      :disabled="!shortcutStore.globalOpen"
      :status="shortcutItem.globalShortcut && shortcutItem.isRegistered ? 'error' : undefined"
      :placeholder="t('setting.shortcut.shortcut_placeholder')"
      readonly
      class="shortcut-input"
      @focus="onFocus(true)"
      @blur="onBlur"
      @keydown.stop="onKeyDown"
      @keyup="keyHandled = ''"
    >
      <template #prefix>
        <n-text :depth="3">{{ t("common.global") }}</n-text>
      </template>
    </n-input>
  </n-flex>
</template>

<script setup lang="ts">
import { useShortcutStore } from "@/stores";
import type { ShortcutKey } from "@/stores/shortcut";
import { platform } from "@/platform";
import {
  normalizeShortcut,
  shortcutSession,
  type ShortcutSession,
} from "@/platform/shortcutSession";
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import type { InputInst } from "naive-ui";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const props = defineProps<{ shortcutKey: ShortcutKey; allowGlobal?: boolean }>();
const shortcutStore = useShortcutStore();
const shortcutItem = computed(() => shortcutStore.shortcutList[props.shortcutKey]);
const localInput = ref<InputInst | null>(null);
const globalInput = ref<InputInst | null>(null);
const isFocus = ref(false);
const isGlobalFocus = ref(false);
const keyHandled = ref("");
let recording: { session: ShortcutSession; token: symbol } | undefined;
const finishRecording = () => {
  const current = recording;
  recording = undefined;
  if (current) void current.session.endRecording(current.token);
};
const onFocus = (global: boolean) => {
  finishRecording();
  isFocus.value = true;
  isGlobalFocus.value = global;
  keyHandled.value = "";
  const session = shortcutSession(shortcutStore);
  if (global && session) recording = { session, token: session.beginRecording() };
};
const onBlur = () => {
  isFocus.value = false;
  isGlobalFocus.value = false;
  keyHandled.value = "";
  finishRecording();
};
const onWindowBlur = () => {
  if (!isFocus.value) return;
  const input = isGlobalFocus.value ? globalInput.value : localInput.value;
  onBlur();
  input?.blur();
};
const onVisibilityChange = () => {
  if (document.visibilityState === "hidden") onWindowBlur();
};
onMounted(() => {
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
  window.removeEventListener("blur", onWindowBlur);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  onBlur();
});
const onKeyDown = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
  if (!isFocus.value || event.repeat || event.code === keyHandled.value) return;
  keyHandled.value = event.code;
  const field = isGlobalFocus.value ? "globalShortcut" : "shortcut";
  if (event.code === "Backspace") {
    shortcutItem.value[field] = "";
    return;
  }
  if (
    !/^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Escape|Arrow(Left|Right|Up|Down))$/.test(
      event.code,
    )
  )
    return;
  const modified = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
  let shortcut = [
    (event.ctrlKey || event.metaKey) && "CmdOrCtrl",
    event.shiftKey && "Shift",
    event.altKey && "Alt",
    event.code,
  ]
    .filter(Boolean)
    .join("+");
  if (isGlobalFocus.value) {
    shortcut = [
      event.metaKey && "Super",
      event.ctrlKey && "Control",
      event.shiftKey && "Shift",
      event.altKey && "Alt",
      event.code,
    ]
      .filter(Boolean)
      .join("+");
    if (!modified) shortcut = "CmdOrCtrl+Shift+" + event.code;
  }
  const normalized = normalizeShortcut(shortcut, platform.os);
  const duplicate = Object.entries(shortcutStore.shortcutList).some(
    ([key, item]) =>
      key !== props.shortcutKey &&
      (field !== "globalShortcut" ||
        platform.shortcuts?.actions.some((action) => action === key)) &&
      normalizeShortcut(item[field], platform.os) === normalized,
  );
  if (duplicate) {
    window.$message.warning(t("message.shortcut_repeat"));
    return;
  }
  shortcutItem.value[field] = shortcut;
  if (!isGlobalFocus.value) window.$message.success(t("message.shortcut_set_success"));
};
</script>

<style scoped lang="scss">
.shortcut-input {
  flex: 1;
  text-align: center;
  :deep(input) {
    text-align: center;
  }
}
.n-flex {
  gap: 12px;
}
</style>
