<template>
  <div class="exclude-lyrics-modal">
    <n-flex vertical size="large">
      <n-card class="switch-card" size="small">
        <n-flex align="center" justify="space-between">
          <n-text>{{ t("setting.lyrics.lyrics_exclude_online") }}</n-text>
          <n-switch v-model:value="enableOnlineLyricsExclude" :round="false" />
        </n-flex>
      </n-card>
      <n-card class="switch-card" size="small">
        <n-flex align="center" justify="space-between">
          <n-text class="name">{{ t("setting.lyrics.lyrics_exclude_local") }}</n-text>
          <n-switch v-model:value="enableExcludeLocalLyrics" class="set" :round="false" />
        </n-flex>
      </n-card>

      <n-tabs v-model:value="page" animated>
        <n-tab-pane name="keywords" :tab="t('common.keyword')">
          <n-scrollbar style="max-height: 50vh">
            <n-flex vertical :size="12">
              <n-dynamic-tags v-model:value="filterKeywords" />
              <n-button
                v-if="filterKeywords.length"
                type="error"
                secondary
                size="small"
                @click="clearKeywords"
              >
                <template #icon>
                  <SvgIcon name="DeleteSweep" />
                </template>
                {{ t("setting.other.clear_all_data_btn") }}
              </n-button>
            </n-flex>
          </n-scrollbar>
        </n-tab-pane>

        <n-tab-pane name="regexes" :tab="t('common.regex')">
          <n-scrollbar style="max-height: 50vh">
            <n-flex vertical :size="12">
              <n-text depth="3">
                {{ t("setting.lyrics.lyrics_exclude_regex_tip") }}
                <code>/</code>
              </n-text>
              <div class="regex-list">
                <div v-for="(_, index) in filterRegexes" :key="`regex-${index}`" class="regex-item">
                  <n-input
                    v-model:value="filterRegexes[index]"
                    :placeholder="t('setting.lyrics.lyrics_exclude_regex_placeholder')"
                    @blur="normalizeRegex(index)"
                  />
                  <n-button secondary type="error" class="regex-action" @click="removeRegex(index)">
                    <template #icon>
                      <SvgIcon name="Delete" />
                    </template>
                  </n-button>
                  <n-text v-if="invalidRegexIndexes.includes(index)" depth="3" type="error">
                    {{ t("setting.lyrics.lyrics_exclude_regex_invalid") }}
                  </n-text>
                </div>
              </div>
              <n-button dashed block @click="addRegex">
                <template #icon>
                  <SvgIcon name="Add" />
                </template>
                {{ t("setting.lyrics.lyrics_exclude_regex_add") }}
              </n-button>
              <n-button
                v-if="hasRegexContent"
                type="error"
                secondary
                size="small"
                @click="clearRegexes"
              >
                <template #icon>
                  <SvgIcon name="DeleteSweep" />
                </template>
                {{ t("setting.other.clear_all_data_btn") }}
              </n-button>
            </n-flex>
          </n-scrollbar>
        </n-tab-pane>
      </n-tabs>

      <n-divider style="margin: 6px 0" />
      <n-flex align="center" justify="space-between">
        <n-button secondary @click="resetDefaultRules">
          {{ t("common.reset_default") }}
        </n-button>
        <n-flex>
          <n-button @click="handleClose">{{ t("common.cancel") }}</n-button>
          <n-button type="primary" @click="saveFilter">{{ t("common.save") }}</n-button>
        </n-flex>
      </n-flex>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { keywords, regexes } from "@/assets/data/exclude";
import { useSettingStore } from "@/stores";
import { useI18n } from "vue-i18n";

const emit = defineEmits(["close"]);

const settingStore = useSettingStore();
const { t } = useI18n();

const enableOnlineLyricsExclude = ref(settingStore.enableOnlineLyricsExclude);
const enableExcludeLocalLyrics = ref(settingStore.enableLocalLyricsExclude);

const filterKeywords = ref<string[]>([]);
const filterRegexes = ref<string[]>([]);
const page = ref("keywords");

/** 当前是否存在正则内容 */
const hasRegexContent = computed(() => filterRegexes.value.some((item) => item.trim()));

/** 无效正则所在索引 */
const invalidRegexIndexes = computed(() => {
  return filterRegexes.value.reduce<number[]>((result, line, index) => {
    const value = line.trim();
    if (!value) return result;
    try {
      new RegExp(value);
      return result;
    } catch {
      result.push(index);
      return result;
    }
  }, []);
});

/** 保存前的正则列表 */
const parsedRegexes = computed(() =>
  filterRegexes.value.map((line) => line.trim()).filter(Boolean),
);

// 清空关键词
const clearKeywords = () => {
  filterKeywords.value = [];
};

// 清空正则表达式
const clearRegexes = () => {
  filterRegexes.value = [];
};

// 新增正则表达式
const addRegex = () => {
  filterRegexes.value.push("");
};

// 删除正则表达式
const removeRegex = (index: number) => {
  filterRegexes.value.splice(index, 1);
};

// 规范化正则内容
const normalizeRegex = (index: number) => {
  filterRegexes.value[index] = filterRegexes.value[index]?.trim() || "";
};

// 恢复默认排除规则
const resetDefaultRules = () => {
  filterKeywords.value = [...keywords];
  filterRegexes.value = [...regexes];
  window.$message.success(t("setting.lyrics.lyrics_exclude_reset_success"));
};

// 保存过滤
const saveFilter = () => {
  if (invalidRegexIndexes.value.length) {
    window.$message.error(
      t("setting.lyrics.lyrics_exclude_regex_invalid_message", {
        lines: invalidRegexIndexes.value.map((index) => index + 1).join("、"),
      }),
    );
    page.value = "regexes";
    return;
  }
  settingStore.enableOnlineLyricsExclude = enableOnlineLyricsExclude.value;
  settingStore.enableLocalLyricsExclude = enableExcludeLocalLyrics.value;
  settingStore.lyricsExcludeKeywords = filterKeywords.value;
  settingStore.lyricsExcludeRegexes = parsedRegexes.value;
  handleClose();
};

const handleClose = () => {
  emit("close");
};

onMounted(() => {
  enableOnlineLyricsExclude.value = settingStore.enableOnlineLyricsExclude;
  enableExcludeLocalLyrics.value = settingStore.enableLocalLyricsExclude;
  filterKeywords.value = [...(settingStore.lyricsExcludeKeywords || [])];
  filterRegexes.value = [...(settingStore.lyricsExcludeRegexes || [])];
});
</script>

<style lang="scss" scoped>
.exclude-lyrics-modal {
  padding: 0;
  .switch-card {
    width: 100%;
    border-radius: 8px;
    .n-text {
      font-size: 16px;
    }
  }

  code {
    padding: 2px 6px;
    border-radius: 6px;
    background-color: var(--n-border-color);
    font-family: auto;
  }

  .regex-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .regex-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: start;

    .n-text {
      grid-column: 1 / -1;
      font-size: 12px;
    }
  }

  .regex-action {
    height: 34px;
  }

  .set-list {
    margin-bottom: 24px;
    &:last-child {
      margin-bottom: 0;
    }
  }
  .set-item {
    width: 100%;
    border-radius: 8px;
    margin-bottom: 12px;
    transition: margin 0.3s;
    &:last-child {
      margin-bottom: 0;
    }
    :deep(.n-card__content) {
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
    }
    .label {
      display: flex;
      flex-direction: column;
      padding-right: 20px;
      .name {
        font-size: 16px;
      }
    }
    .n-flex {
      flex-flow: nowrap !important;
    }
    .set {
      justify-content: flex-end;
      width: 200px;
      &.n-switch {
        width: max-content;
      }
      @media (max-width: 768px) {
        width: 140px;
        min-width: 140px;
      }
    }
  }
}
</style>
