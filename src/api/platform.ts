import { requestHemusic } from "@/utils/request";

export const FeatureSupportFlag = {
  // 搜索相关
  ComprehensiveSearch: 1n << 0n, // 复合搜索
  SearchSong: 1n << 1n, // 搜索歌曲
  SearchAlbum: 1n << 2n, // 搜索专辑
  SearchPlaylist: 1n << 3n, // 搜索歌单
  SearchMV: 1n << 4n, // 搜索MV
  SearchSinger: 1n << 5n, // 搜索歌手
  GetSearchSuggest: 1n << 6n, // 获取搜索建议
  GetSearchHotkey: 1n << 7n, // 获取搜索热词

  // 排行榜相关
  GetTopList: 1n << 8n, // 获取排行榜
  GetTopInfo: 1n << 9n, // 获取排行榜详情

  // 歌单相关
  GetTagList: 1n << 10n, // 获取歌单标签列表
  GetTagPlaylist: 1n << 11n, // 获取标签的歌单列表

  // 歌手相关
  GetSingerSong: 1n << 12n, // 获取歌手歌曲
  GetSingerAlbum: 1n << 13n, // 获取歌手专辑
  GetSingerMV: 1n << 14n, // 获取歌手MV
  GetSingerInfo: 1n << 15n, // 获取歌手信息

  // 歌曲相关
  GetSongInfo: 1n << 16n, // 获取歌曲信息
  GetMVInfo: 1n << 17n, // 获取MV信息
  GetPlaylistInfo: 1n << 18n, // 获取歌单信息
  GetAlbumInfo: 1n << 19n, // 获取专辑信息
  GetSongLyric: 1n << 20n, // 根据歌曲id获取歌词信息
  GetLyricInfo: 1n << 21n, // 根据歌词id获取歌词
  GetSongUrl: 1n << 22n, // 获取歌曲链接
  GetMVUrl: 1n << 23n, // 获取MV链接
  GetSongCover: 1n << 24n, // 获取歌曲封面

  // 评论相关
  GetCommentList: 1n << 25n, // 获取评论列表

  // 推荐相关
  GetDailyRecommendSongList: 1n << 26n, // 获取每日推荐歌曲列表
  GetRecommendPlaylist: 1n << 27n, // 获取推荐歌单
  GetNewSongTabList: 1n << 28n, // 获取新歌TAB列表
  GetNewSongList: 1n << 29n, // 获取新歌列表
  GetNewAlbumTabList: 1n << 30n, // 获取新碟TAB列表
  GetNewAlbumList: 1n << 31n, // 获取新碟列表
  GetRecommendPage: 1n << 32n, // 获取推荐页
  GetDiscoverPage: 1n << 33n, // 获取发现页

  // 来源链接
  BuildSourceUrl: 1n << 34n, // 构建来源链接
  ParseSourceUrl: 1n << 35n, // 解析来源链接

  SearchAudiobook: 1n << 36n, // 搜索有声书

  ListArtistTabs: 1n << 37n, // 获取歌手TAB列表
  ListTabArtists: 1n << 38n, // 获取TAB歌手列表

  ListRadios: 1n << 39n, // 获取电台列表
  ListRadioSongs: 1n << 40n, // 获取电台歌曲列表

  FeatureSupportListArtistPhotos: 1n << 41n,

  FeatureSupportListMVFilters: 1n << 42n, // 获取MV筛选列表
  FeatureSupportListFilterMVs: 1n << 43n, // 获取筛选后的MV列表

  GetSongDetail: 1n << 44n, // 获取歌曲详情
  ListSongRelations: 1n << 45n, // 获取歌曲相关推荐

  ListMVFeeds: 1n << 46n, // 获取MV信息流
  GetSearchDefault: 1n << 47n, //搜索默认词
};

// 获取发现页面
export const platforms = () => {
  return requestHemusic({
    url: "/v1/platforms",
    params: {},
  });
};
