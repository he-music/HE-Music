<template>
  <Transition name="fade" mode="out-in">
    <n-flex
      v-if="data.length > 0 || loadMore"
      :size="20"
      :class="['comment-list', { transparent }]"
      vertical
    >
      <n-flex
        v-for="(item, index) in data"
        :key="`${item.id}-${index}`"
        :size="20"
        class="comments"
      >
        <div class="user">
          <div class="avatar">
            <n-image
              :src="item.user?.avatar && item.user.avatar.replace(/^http:/, 'https:')"
              class="cover"
              preview-disabled
              lazy
              @load="coverLoaded"
            >
              <template #placeholder>
                <div class="cover-loading">
                  <img src="/images/avatar.jpg?asset" class="loading-img" alt="loading-img" />
                </div>
              </template>
            </n-image>
          </div>
        </div>
        <!-- 内容 -->
        <div class="data">
          <!-- 评论 -->
          <div class="content">
            <n-text class="name"> {{ item.user.name || t("common.unknown_user") }}： </n-text>
            <n-text v-if="item.be_replied && !item.be_replied.content" class="name">
              {{ t("common.reply") }} @
              {{ item.be_replied.user.name || t("common.unknown_user") }}：
            </n-text>
            <n-text v-dompurify-html="getContent(item.content)" class="text" />
          </div>
          <!-- 回复 -->
          <div v-if="item.be_replied && item.be_replied.content" class="reply">
            <n-text class="name" :depth="3">
              @ {{ item.be_replied.user.name || t("common.unknown_user") }}：
            </n-text>
            <n-text v-dompurify-html="getContent(item.be_replied.content)" class="text" />
          </div>
          <!-- 信息 -->
          <n-flex class="meta" align-items="center">
            <div class="item">
              <SvgIcon name="Time" :depth="3" />
              <n-text :depth="3">
                {{ formatCommentTime(Number(item.timestamp) * 1000) }}
              </n-text>
            </div>
            <div v-if="item.ip_location" :title="item.ip_location" class="item">
              <SvgIcon name="IP" :depth="3" />
              <n-text :depth="3">{{ item.ip_location }}</n-text>
            </div>
            <!-- 点赞 -->
            <div class="item like">
              <SvgIcon name="ThumbUp" :depth="1" />
              <n-text :depth="1">
                {{ n(Number(item.praise_count) || 0, "number") }}
              </n-text>
            </div>
          </n-flex>
          <!-- 回复 -->
          <div
            v-if="item.sub_comments.length > 0 || Number(item.reply_count) > 0"
            class="sub-comment"
          >
            <CommentList
              :data="item.sub_comments"
              :load-more="item.sub_has_more"
              :loading="item.sub_loading"
              sub
              :sub-count="item.sub_page_index === 1"
              :total="Number(item.reply_count)"
              @load-more="emit('loadSubMore', item)"
            />
          </div>
        </div>
      </n-flex>
      <!-- 加载更多 -->
      <n-flex v-if="loadMore" class="load-more" justify="center">
        <n-button :loading="loading" size="large" strong secondary round @click="emit('loadMore')">
          {{
            sub
              ? subCount && total
                ? t("common.comment_count_noun", { count: total })
                : t("common.view_more_comment")
              : t("common.load_more")
          }}
        </n-button>
      </n-flex>
    </n-flex>
    <div v-else-if="loading" :class="['comment-list', { transparent }]">
      <n-skeleton :repeat="20" />
    </div>
    <!-- 空列表 -->
    <n-empty v-else :description="t('common.list_empty')" size="large" />
  </Transition>
</template>

<script setup lang="ts">
import { coverLoaded } from "@/utils/helper";
import { formatCommentTime } from "@/utils/time";
import type { CommentInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
const { t, n } = useI18n();

defineProps<{
  sub?: boolean;
  subCount?: boolean;
  total?: number;
  data: CommentInfo[];
  loading?: boolean;
  loadMore?: boolean;
  // 透明
  transparent?: boolean;
}>();

const emit = defineEmits<{
  // 加载更多
  loadMore: [];
  // 加载子评论
  loadSubMore: [item: CommentInfo];
}>();

// 获取评论内容
const getContent = (content: string) => {
  return content;
  // try {
  //   if (!content) return;
  //   content = content.trim();
  //   // 正则
  //   const emojiRegex = /\[(\S+?)\]/g;
  //   // 替换内容为表情
  //   const replacedText = content.replace(emojiRegex, (match, emojiName) => {
  //     // 在 emojiData 中查找匹配的 emojiName 对应的 emoji
  //     const emojiObject = emoji.find((emoji) => emoji.emjName === emojiName);
  //     // 如果找到了对应的 emoji，则返回该 emoji，否则返回原始字符串
  //     return emojiObject ? emojiObject.emoji : match;
  //   });
  //   return replacedText;
  // } catch (error) {
  //   console.error(error);
  //   return content;
  // }
};
</script>

<style lang="scss" scoped>
.comment-list {
  margin-bottom: 20px;
  :deep(.n-skeleton) {
    min-height: 128px;
    border-radius: 12px;
    margin-bottom: 20px;
  }
  .comments {
    min-height: 128px;
    border-radius: 12px;
    padding: 16px;
    border: 2px solid rgba(var(--primary), 0.12);
    background-color: var(--surface-container-hex);
    .user {
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 60px;
      width: 60px;
      .avatar {
        position: relative;
        display: flex;
        justify-content: center;
        width: 54px;
        height: 54px;
        .cover {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          overflow: hidden;
          :deep(img) {
            width: 100%;
            height: 100%;
            opacity: 0;
            transition: opacity 0.35s ease-in-out;
          }
        }
        .annual {
          position: absolute;
          height: 16px;
          right: 0;
          bottom: 0;
          background-color: #fff;
          border: 1px solid #fff3;
          border-radius: 50%;
        }
      }
    }
    .data {
      display: flex;
      flex-direction: column;
      flex: 1;
      width: 100%;
      .content {
        .name {
          font-weight: bold;
          cursor: pointer;
          &:hover {
            color: var(--primary-hex);
          }
        }
        .text {
          white-space: pre-wrap;
        }
      }
      .reply {
        width: 100%;
        padding: 4px 0;
        border-radius: 8px;
        font-size: 13px;
        margin-top: 6px;
        background-color: rgba(var(--main-cover-color), 0.08);
        .text {
          white-space: pre-wrap;
        }
      }

      .sub-comment {
        width: 100%;
        padding: 4px 0;
        border-radius: 8px;
        font-size: 13px;
        margin-top: 6px;
      }

      .meta {
        padding-top: 12px;
        margin-top: auto;
        .item {
          display: flex;
          align-items: center;
          .n-icon {
            font-size: 16px;
            margin-right: 4px;
          }
        }
        .like {
          margin-left: auto;
          cursor: pointer;
          &:hover {
            .n-icon,
            .n-text {
              color: var(--primary-hex);
              :deep(svg) {
                opacity: 1;
              }
            }
          }
        }
      }
    }
  }
  &.transparent {
    .comments {
      border-color: transparent;
      background-color: rgba(var(--main-cover-color), 0.08);
      .content {
        font-size: 16px;
      }
    }
  }
}
</style>
