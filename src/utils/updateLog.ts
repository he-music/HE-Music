import type { UpdateLogType } from "@/types/main";
import { updateLog } from "@/api/other";
import { getCacheData } from "./cache";
import { convertToLocalTime } from "./time";

/** 更新日志展示时才加载 Markdown 解析器。 */
export async function getUpdateLog(): Promise<UpdateLogType[]> {
  const releases = await getCacheData(updateLog, { key: "updateLog", time: 10 });
  if (!releases?.length) return [];
  const { marked } = await import("marked");
  return Promise.all(
    releases.map(async (release) => ({
      version: release.tag_name,
      changelog: release.body ? await marked(release.body) : "",
      time: convertToLocalTime(release.published_at),
      url: release.html_url,
      prerelease: release.prerelease,
    })),
  );
}
