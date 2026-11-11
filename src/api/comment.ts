import { requestHemusic } from "@/utils/request";

/**
 * 获取评论
 * @param id - 对应资源的 id
 * @param platform
 * @param resource_type
 * @param page_index
 * @param page_size
 * @param last_id
 * @param is_hot
 */
export const getComment = (
  id: string,
  platform: string,
  resource_type: string,
  page_index: number = 1,
  page_size: number = 20,
  last_id?: string,
  is_hot?: boolean,
) => {
  return requestHemusic({
    url: "/v1/comments",
    params: {
      id,
      platform,
      resource_type,
      page_index,
      page_size,
      last_id,
      is_hot,
    },
  });
};

/**
 * 获取子评论
 * @param id - 对应资源的 id
 * @param platform
 * @param parent_id - 父评论 id
 * @param resource_type
 * @param page_index
 * @param page_size
 * @param last_id
 */
export const getSubComment = (
  id: string,
  platform: string,
  parent_id: string,
  resource_type: string,
  page_index: number = 1,
  page_size: number = 15,
  last_id?: string,
) => {
  return requestHemusic({
    url: "/v1/comment/subs",
    params: {
      id,
      platform,
      parent_id,
      resource_type,
      page_index,
      page_size,
      last_id,
    },
  });
};
