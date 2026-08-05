import type {
  AlbumInfo,
  ArtistInfo,
  MVInfo,
  PlaylistInfo,
  RadioInfo,
  RankingInfo,
  SongInfo,
} from "@/types/main.hemusic";

export const PageSectionType = {
  Unspecified: 0,
  Generic: 1,
  NewSongs: 2,
  NewAlbums: 3,
  Ranking: 4,
  Feed: 5,
  QuickEntries: 6,
} as const;

export type PageSectionTypeValue = (typeof PageSectionType)[keyof typeof PageSectionType];

export const PageEntryTargetType = {
  Unspecified: 0,
  SongList: 1,
  Radio: 2,
  Playlist: 3,
} as const;

export type PageEntryTargetTypeValue =
  (typeof PageEntryTargetType)[keyof typeof PageEntryTargetType];

export interface PageEntry {
  target_type: number;
  target_id: string;
  title: string;
  subtitle?: string;
  cover?: string;
}

export type PageResourceType =
  | "song"
  | "album"
  | "mv"
  | "playlist"
  | "ranking"
  | "radio"
  | "artist";

export type PageSectionResource =
  | SongInfo
  | AlbumInfo
  | MVInfo
  | PlaylistInfo
  | RankingInfo
  | RadioInfo
  | ArtistInfo;

export interface PageSection {
  section_type: number;
  resource_type: string;
  title?: string;
  songs?: SongInfo[];
  albums?: AlbumInfo[];
  mvs?: MVInfo[];
  playlists?: PlaylistInfo[];
  rankings?: RankingInfo[];
  radios?: RadioInfo[];
  artists?: ArtistInfo[];
  entries?: PageEntry[];
}

export interface NormalizedPageSection extends Omit<PageSection, "resource_type" | "title"> {
  resource_type: string;
  title: string;
}

export interface RecommendSongListInfo {
  id: string;
  title: string;
  cover: string;
  description: string;
  songs: SongInfo[];
}

export interface DiscoverPageResponse {
  sections?: PageSection[];
}

export interface RecommendPageResponse {
  sections?: PageSection[];
  has_more: boolean;
}
