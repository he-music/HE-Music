export interface PlatformInfo {
  //平台id
  id: string;
  //名字
  name: string;
  //缩写
  shortname: string;
  //排序 从小到大
  order: number;
  //标签
  tags: string[];
  // 支持的功能
  feature_support_flag: bigint;
  // 状态
  status: number;
  // 图片尺寸
  image_sizes: number[];
  // 平台音质
  qualities: PlatformQuality[];
  // 音质映射说明
  quality_map: Map<string, string>;
}

export interface PlatformQuality {
  name: string;
  description: string;
}

export interface Link {
  name: string;
  quality: number;
  format: string;
  size: string;
  url: string;
}

export interface ArtistInfo {
  id: string;
  name: string;
  cover: string;
  platform: string;
  description: string;
  mv_count: string;
  song_count: string;
  album_count: string;
  alias: string;
}

export interface SongInfo {
  name: string;
  subtitle: string;
  id: string;
  duration: number;
  mv_id: string;
  album: SongInfoAlbumInfo | string;
  artists?: SongInfoArtistInfo[] | string;
  links: Link[];
  platform: string;
  cover: string;

  // 以下
  path?: string;
  size?: number;
  quality?: string;
  alias?: string;
}

/** 搜索结果中的歌曲及其命中上下文。 */
export interface SearchSongInfo {
  song: SongInfo;
  sublist: SearchSongInfo[];
  original_type: number;
  lyric_snippet: string;
  lyric: string;
  matched_keywords: string[];
}

export interface PlaylistInfo extends CoverType {
  name: string;
  id: string;
  cover: string;
  creator: string;
  song_count: string;
  play_count: string;
  songs: SongInfo[];
  platform: string;
  description: string;
  categories: CategoryInfo[];
}

export interface AlbumInfo extends CoverType {
  name: string;
  id: string;
  cover: string;
  artists: SongInfoArtistInfo[];
  song_count: string;
  publish_time: string;
  songs: SongInfo[];
  description: string;
  platform: string;
  language: string;
  genre: string;
  type: number;
  is_finished: boolean;
  play_count: string;
}

export interface LyricInfo {
  id: string;
  lyric: string;
  trans: string;
  platform: string;
  roma: string;
}

export interface SongMetadata {
  language: string;
  publish_time: number;
}

export interface MVInfo extends CoverType {
  platform: string;
  links: Link[];
  //Id
  id: string;
  //显示的标题
  name: string;
  cover: string;
  //MVType
  type: number;
  play_count: string;
  creator: string;
  duration: number;
  description: string;
}

export interface CommentInfo {
  id: string;
  content: string;
  timestamp: string;
  praise_count: string;
  user: CommentInfoUser;
  be_replied: CommentInfo;
  reply_count: string;
  ip_location: string;
  sub_comments: CommentInfo[];

  // 子评论用
  sub_has_more: boolean;
  sub_loading: boolean;
  sub_last_id: string;
  sub_page_index: number;
}

export interface RankingInfo extends CoverType {
  name: string;
  id: string;
  cover: string;
  play_count: string;
  songs: SongInfo[];
  platform: string;
  description: string;
  page_index: number;
  page_size: number;
  total_count: string;
  last_id: string;
  has_more: boolean;
}

export interface CategoryGroupInfo {
  name: string;
  categories: CategoryInfo[];
}

export interface CategoryInfo {
  //70后
  name: string;
  id: string;
  platform: string;
}

export interface SongInfoArtistInfo {
  id: string;
  name: string;
}

export interface SongInfoAlbumInfo {
  name: string;
  id: string;
}

export interface CommentInfoUser {
  name: string;
  id: string;
  avatar: string;
}

export interface TabInfo {
  name: string;
  id: string;
  platform: string;
}

export interface UserPlaylistInfo extends PlaylistInfo {
  name: string;
  id: string;
  cover: string;
  creator: string;
  song_count: string;
  songs: SongInfo[];
  song_ids: IDPlatformInfo[];
  description: string;

  user_id: string;
  is_default: number;
  created_at: string;
}

export interface UserFavouritePlaylistInfo extends PlaylistInfo {
  name: string;
  id: string;
  cover: string;
  creator: string;
  platform: string;
}

export interface UserFavouriteAlbumInfo extends AlbumInfo {
  name: string;
  id: string;
  cover: string;
  artists: SongInfoArtistInfo[];
  platform: string;
}

export interface UserFavouriteArtistInfo extends ArtistInfo {
  name: string;
  id: string;
  cover: string;
  platform: string;
}

export interface UserInfo {
  //用户id
  id: string;
  //用户名
  username: string;
  //昵称
  nickname: string;
  //email
  email: string;
  //状态
  status: number;
  // 头像
  avatar: string;
}

export interface IDPlatformInfo {
  //平台
  platform: string;
  //id
  id: string;
}

export interface UserFavouriteSongInfo {
  id: string;
  platform: string;
}

export interface CoverType {
  loading: boolean;
  id: string;
  platform: string;
  name: string;
}

export interface SearchDefaultInfo {
  key: string;
  description: string;
}

export interface SearchSongResponse {
  platform: string;
  key: string;
  list: SearchSongInfo[];
  page_index: number;
  page_size: number;
  total_count: number;
  has_more: boolean;
}

export interface SearchLyricSongRequest {
  platform: string;
  key: string;
  page_index: number;
  page_size: number;
}

export type SearchLyricSongResponse = SearchSongResponse;

// 综合搜索结果
export interface ComprehensiveSearchResponse {
  key: string;
  song: {
    list: SearchSongInfo[];
    has_more: boolean;
    total_count: number;
  };
  playlist: {
    list: PlaylistInfo[];
    has_more: boolean;
    total_count: number;
  };
  album: {
    list: AlbumInfo[];
    has_more: boolean;
    total_count: number;
  };
  mv: {
    list: MVInfo[];
    has_more: boolean;
    total_count: number;
  };
  artist: {
    list: ArtistInfo[];
    has_more: boolean;
    total_count: number;
  };
  best_match: {
    primary: RecommendItem | null;
    recommendations: RecommendItem[];
  } | null;
}

// 综合搜索推荐项
export interface RecommendItem {
  resource_type: string;
  artist?: ArtistInfo;
  playlist?: PlaylistInfo;
  album?: AlbumInfo;
  song?: SearchSongInfo;
  mv?: MVInfo;
}

export interface Option {
  value: string;
  label: string;
}

export interface RadioInfo {
  name: string;
  id: string;
  cover: string;
  platform: string;

  loading: boolean;
}

export interface FilterInfo {
  id: string;
  platform: string;
  options: Option[];
}

export interface CommentConfig {
  id: string;
  name: string;
  creator: string;
  platform: string;
  cover: string;
  resource_type: CommentResourceType;
}

export type CommentResourceType = "song" | "mv" | "album" | "playlist";

// 设备信息（登录/刷新时上报）
export interface DeviceInfo {
  device_id: string; // 设备唯一标识（前端生成）
  platform: string; // macos, windows, linux, android, ios
  app_type: string; // electron, web
  app_version?: string;
  device_name?: string;
}

// 设备列表项
export interface Device {
  device_id: string;
  display_name: string;
  platform: string;
  app_type: string;
  app_version: string;
  device_name: string;
  location: string;
  last_active_at: number;
  is_current_device: boolean;
}
