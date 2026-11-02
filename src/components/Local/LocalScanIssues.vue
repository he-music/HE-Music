<template>
  <details v-if="issues.length" class="scan-issues" data-scan-issues>
    <summary>
      {{ t("local.scan_partial_detail", { count: issues.length }) }}
      {{ t("mygo.library.scanDetails") }}
    </summary>
    <ul>
      <li v-for="issue in issues" :key="`${issue.grantToken}:${issue.relativePath}:${issue.code}`">
        <span class="path"
          >{{ session?.directoryPath(issue.grantToken) }} / {{ issue.relativePath || "." }}</span
        >
        <span
          >{{ reason(issue.code) }} <code>({{ issue.code }})</code></span
        >
      </li>
    </ul>
  </details>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { localFilesSession } from "@/platform/localFilesSession";

const { t } = useI18n();
const session = localFilesSession;
const issues = computed(() => session.value?.issues.value ?? []);
const known = new Set([
  "path",
  "read-directory",
  "changed",
  "item-limit",
  "stat",
  "symlink",
  "depth-limit",
  "special-file",
  "reference-limit",
  "index-save-failed",
]);
const reason = (code: string) =>
  known.has(code) ? t(`mygo.library.scanReasons.${code}`) : t("mygo.library.scanReasons.unknown");
</script>

<style scoped lang="scss">
.scan-issues {
  margin: 12px 0;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--surface-container-hex);
  summary {
    cursor: pointer;
  }
  ul {
    margin: 12px 0 0;
    padding-left: 20px;
  }
  li {
    margin: 8px 0;
  }
  .path {
    display: block;
    overflow-wrap: anywhere;
  }
  code {
    opacity: 0.7;
  }
}
</style>
