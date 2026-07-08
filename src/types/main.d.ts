import { songLevelData } from "@/utils/meta";
import type {
  MVInfo,
  UserFavouriteAlbumInfo,
  UserFavouritePlaylistInfo,
  UserFavouriteArtistInfo,
  UserFavouriteSongInfo,
} from "@/types/main.hemusic";

export type MetaData = {
  id: number;
  name: string;
  cover?: string;
  alias?: string[];
};

export type DjData = {
  id: number;
  name: string;
  creator?: string;
};

export type CoverSize = {
  s: string;
  m: string;
  l: string;
  xl: string;
};

export type UserType = {
  id: number;
  name: string;
  avatarUrl: string | undefined;
  vipType?: number;
  vipLevel?: number;
  vipIconUrl?: string;
  isAnnualCount?: boolean;
};

export type SongType = {
  id: number;
  name: string;
  artists: MetaData[] | string;
  album: MetaData | string;
  dj?: DjData;
  cover: string;
  coverSize?: CoverSize;
  duration: number;
  // 0: 未知 | 1: 原曲 | 2: 翻唱
  originCoverType?: number;
  alia?: string;
  // 0: 免费或无版权 | 1: VIP 歌曲 | 4: 购买专辑 | 8: 非会员可免费播放低音质，会员可播放高音质及下载
  free: 0 | 1 | 4 | 8;
  mv: number | null;
  path?: string;
  pc?: boolean;
  size?: number;
  quality?: "Hi-Res" | "HQ" | "SQ";
  createTime?: number;
  updateTime?: number;
  playCount?: number;
  // 歌曲类型
  type: "song" | "radio";
};

// Cover
export type CoverType = {
  id: number;
  name: string;
  cover: string;
  coverSize?: CoverSize;
  description?: string;
  creator?: UserType;
  artists?: MetaData[] | string;
  count?: number;
  tags?: string[];
  userId?: number | null;
  count?: number;
  privacy?: number;
  playCount?: number;
  liked?: boolean;
  likedCount?: number;
  commentCount?: number;
  shareCount?: number;
  subCount?: number;
  playCount?: number;
  createTime?: number;
  updateTime?: number;
  loading?: boolean;
  updateTip?: string;
  tracks?: {
    first: string;
    second: string;
  }[];
};

// Artist
export type ArtistType = {
  id: number;
  name: string;
  cover: string;
  coverSize?: CoverSize;
  alia?: string;
  identify?: string;
  description?: string;
  albumSize?: number;
  musicSize?: number;
  mvSize?: number;
  fansSize?: number;
};

// Comment
export type CommentType = {
  id: number;
  content: string;
  beReplied?: {
    content: string;
    user: UserType;
  };
  time: number;
  user: UserType;
  ip?: {
    ip: string;
    location: string;
  };
  liked?: boolean;
  likedCount?: number;
};

export type PlayModeType = "repeat" | "repeat-once" | "shuffle";

/**
 * 歌词内容类型
 */
export type LyricContentType = {
  /** 歌词开始时间 */
  time: number;
  /** 歌词结束时间 */
  endTime: number;
  /** 歌词持续时间 */
  duration: number;
  /** 歌词内容 */
  content: string;
  /** 是否以空格结尾 */
  endsWithSpace: boolean;
};

export type LyricType = {
  /** 歌词开始时间 */
  time: number;
  /** 歌词结束时间 */
  endTime: number;
  /** 翻译歌词 */
  tran?: string;
  /** 音译歌词 */
  roma?: string;
  /** 是否为背景歌词 */
  isBG?: boolean;
  /** 是否为对唱歌词 */
  isDuet?: boolean;
  /** 歌词内容 */
  content: string;
  /** 歌词内容数组 */
  contents: LyricContentType[];
};

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface ColorScheme {
  [key: string]: RGB;
}

export interface CoverColors {
  main?: RGB;
  light?: ColorScheme;
  dark?: ColorScheme;
}

export interface CatType {
  name: string;
  category: number;
  hot?: boolean;
  count?: number;
}

// userData
export interface UserDataType {
  userId: number;
  userType: number;
  vipType: number;
  name: string;
  level?: number;
  avatarUrl?: string;
  backgroundUrl?: string;
  createTime?: number;
  createDays?: number;
  artistCount?: number;
  djRadioCount?: number;
  mvCount?: number;
  subPlaylistCount?: number;
  createdPlaylistCount?: number;
}

export interface UserLikeDataType {
  songs: UserFavouriteSongInfo[];
  playlists: UserFavouritePlaylistInfo[];
  artists: UserFavouriteArtistInfo[];
  albums: UserFavouriteAlbumInfo[];
  mvs: MVInfo[];
}

// songLevel
export type SongLevelType = keyof typeof songLevelData;
export type SongLevelDataType = {
  name: string;
  level: string;
  value: SongLevelType;
  size?: number;
  br?: number;
};

// setting
export type SettingType =
  | "general"
  | "appearance"
  | "play"
  | "lyrics"
  | "keyboard"
  | "local"
  | "network"
  | "about";

// UpdateLog
export type UpdateLogType = {
  version: string;
  changelog: string;
  time: number;
  url: string;
  prerelease: boolean;
  force?: boolean;
};

// 文件信息
export interface FileInfoType {
  url: string;
  sha512: string;
  size: number;
}

// 更新信息
export interface UpdateInfoType {
  tag: string;
  version: string;
  files: FileInfoType[];
  path: string;
  sha512: string;
  releaseDate: string;
  releaseName: string;
  releaseNotes: string;
  prerelease: boolean;
}

// 登录方式
export type LoginType = "qr" | "phone" | "cookie" | "uid" | "password";
// sort
export type SortField = "default" | "title" | "artist" | "album" | "duration" | "size";

export type SortOrder = "default" | "asc" | "desc";
