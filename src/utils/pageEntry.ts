import { PageEntryTargetType, type PageEntry } from "@/types/page";

export type PageEntryAction =
  | {
      type: "route";
      routeName: "recommend-song-list" | "playlist";
      query: Record<string, string>;
    }
  | {
      type: "radio";
      id: string;
      platform: string;
      title: string;
    };

/** 将协议入口转换为现有路由或电台播放动作。 */
export const resolvePageEntryAction = (
  entry: PageEntry,
  platform: string,
): PageEntryAction | null => {
  switch (entry.target_type) {
    case PageEntryTargetType.SongList:
      return {
        type: "route",
        routeName: "recommend-song-list",
        query: { platform, target_id: entry.target_id },
      };
    case PageEntryTargetType.Radio:
      return {
        type: "radio",
        id: entry.target_id,
        platform,
        title: entry.title,
      };
    case PageEntryTargetType.Playlist:
      return {
        type: "route",
        routeName: "playlist",
        query: { platform, id: entry.target_id },
      };
    default:
      return null;
  }
};
