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
} as const;

export type PageSectionTypeValue = (typeof PageSectionType)[keyof typeof PageSectionType];

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
}

export interface NormalizedPageSection extends Omit<PageSection, "resource_type" | "title"> {
  resource_type: PageResourceType;
  title: string;
}

export interface DiscoverPageResponse {
  sections?: PageSection[];
}

export interface RecommendPageResponse {
  sections?: PageSection[];
  has_more: boolean;
}
