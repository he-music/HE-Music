import { afterEach, expect, it } from "vitest";
import { shallowRef } from "vue";
import { mountProductionSfc } from "@/test/productionSfc";

const close: Array<() => void> = [];
afterEach(() => close.splice(0).forEach((dispose) => dispose()));
it("shows expandable scan details with the current directory, file and reason without exposing a grant token", () => {
  const session = shallowRef({
    issues: shallowRef([
      { grantToken: "private-capability", relativePath: "shortcut", code: "symlink" },
      { grantToken: "private-capability", relativePath: "", code: "index-save-failed" },
    ]),
    directoryPath: () => "/Music",
  });
  const host = mountProductionSfc(
    new URL("./LocalScanIssues.vue", import.meta.url),
    {
      "@/platform/localFilesSession": { localFilesSession: session },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    },
    [],
  );
  close.push(host.close);
  const text = host
    .all()
    .map((node) => node.text)
    .join("");
  expect(host.all().some((node) => node.tag === "details")).toBe(true);
  expect(text).toContain("/Music / shortcut");
  expect(text).toContain("/Music / .");
  expect(text).toContain("mygo.library.scanReasons.symlink");
  expect(text).toContain("index-save-failed");
  expect(text).not.toContain("private-capability");
});
