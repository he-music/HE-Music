<template>
  <div class="parse-url">
    <n-form ref="formRef" :model="formData" :rules="formRules">
      <n-form-item :show-label="false" path="url">
        <n-input
          v-model:value="formData.url"
          :autosize="{
            minRows: 4,
            maxRows: 6,
          }"
          :maxlength="300"
          :placeholder="t('modal.parse_source_url_placeholder')"
          type="textarea"
          show-count
          clearable
        />
      </n-form-item>
    </n-form>
    <n-divider style="margin-bottom: 0; margin-top: 0" />
    <div class="parse-url-result">
      <n-skeleton v-if="loading" animated text height="50px" :repeat="2" />
      <n-empty v-else-if="!parseResult.success" :description="t('modal.parse_fail')" size="large" />
      <!-- 解析结果 有loading中-->
      <n-table v-else :bordered="false" :single-line="false">
        <thead>
          <tr>
            <th>{{ t("common.source") }}</th>
            <th>ID</th>
            <th>{{ t("common.type") }}</th>
            <th>{{ t("common.operation") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              {{
                platformStore.getPlatformInfo(parseResult.platform)?.shortname ||
                parseResult.platform
              }}
            </td>
            <td>{{ parseResult.id }}</td>
            <td>{{ typeNameMap[parseResult.type] || parseResult.type }}</td>
            <td>
              <n-button quaternary type="primary" @click="toJump">
                {{ t("common.view_detail") }}
              </n-button>
            </td>
          </tr>
        </tbody>
      </n-table>
    </div>
    <n-divider style="margin-bottom: 0; margin-top: 0" />
    <n-button class="create" type="primary" @click="toParseSourceUrl">
      {{ t("common.parse") }}
    </n-button>
  </div>
</template>

<script setup lang="ts">
import type { FormInst, FormRules } from "naive-ui";
import { useFormRule } from "@/utils/rules";
import { debounce } from "lodash-es";
import { parseSourceUrl } from "@/api/source";
import { usePlatformStore } from "@/stores";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const platformStore = usePlatformStore();
const router = useRouter();
const { textRule } = useFormRule();
const emit = defineEmits<{ close: [] }>();

// 表单类型
interface FormType {
  url: string;
}

const typeNameMap = computed(() => ({
  song: t("common.song"),
  playlist: t("common.playlist"),
  album: t("common.album"),
  artist: t("common.artist"),
  mv: t("common.video"),
}));

const parseResult = ref({
  success: false,
  platform: "",
  id: "",
  type: "",
  songs: [],
});
const loading = ref(false);
// 在线歌单数据
const formRef = ref<FormInst | null>(null);
const formData = ref<FormType>({ url: "" });
const formRules: FormRules = { url: textRule };

// 新建歌单
const toParseSourceUrl = debounce(
  async (e: MouseEvent) => {
    e.preventDefault();
    // 是否输入
    await formRef.value?.validate((errors) => errors);
    loading.value = true;
    parseResult.value.success = false;
    parseResult.value.songs = [];
    parseSourceUrl(formData.value.url)
      .then(async ({ id, platform, type }) => {
        if (!id || !platform || !type) {
          window.$message.error(t("message.parse_fail"));
          return;
        }
        parseResult.value.success = true;
        parseResult.value.id = id;
        parseResult.value.platform = platform;
        parseResult.value.type = type;
      })
      .finally(() => {
        loading.value = false;
      });
  },
  300,
  { leading: true, trailing: false },
);

const toJump = () => {
  emit("close");

  const query = {
    id: parseResult.value.id,
    platform: parseResult.value.platform,
  };
  switch (parseResult.value.type) {
    case "song":
      router.push({ name: "song", query });
      break;
    case "playlist":
      router.push({ name: "playlist", query });
      break;
    case "album":
      router.push({ name: "album", query });
      break;
    case "artist":
      router.push({ name: "artist", query });
      break;
    case "mv":
      router.push({ name: "video", query });
  }
};
</script>

<style lang="scss" scoped>
.parse-url {
  .create {
    width: 100%;
  }

  .parse-url-result {
    height: 130px;
    width: 100%;
  }

  .n-empty {
    //padding: 40px 0;
  }
}
</style>
