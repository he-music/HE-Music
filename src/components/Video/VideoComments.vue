<template>
  <section>
    <n-flex justify="space-between" align="center">
      <n-h3
        >{{ t("common.comment") }} <n-text depth="3">{{ total || "" }}</n-text></n-h3
      >
      <n-flex>
        <n-button
          v-for="type in types"
          :key="type"
          size="small"
          :type="sort === type ? 'primary' : 'default'"
          @click="emit('sort', type)"
        >
          {{ t(type === "hot" ? "common.hottest" : "common.newest") }}
        </n-button>
      </n-flex>
    </n-flex>
    <n-button v-if="failed" @click="emit('retry')">{{ t("page_section.retry") }}</n-button>
    <CommentList
      :data="data"
      :loading="loading"
      :load-more="hasMore && !failed"
      @load-more="emit('more')"
      @load-sub-more="emit('sub', $event)"
    />
  </section>
</template>
<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { CommentInfo } from "@/types/main.hemusic";
const { t } = useI18n();
const types = ["hot", "new"] as const;
defineProps<{
  data: CommentInfo[];
  loading: boolean;
  failed: boolean;
  hasMore: boolean;
  total: number;
  sort: "hot" | "new";
}>();
const emit = defineEmits<{
  sort: [value: "hot" | "new"];
  retry: [];
  more: [];
  sub: [item: CommentInfo];
}>();
</script>
