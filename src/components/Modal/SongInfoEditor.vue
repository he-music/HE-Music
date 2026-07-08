<template>
  <div class="song-info-editor">
    <n-tabs type="segment" animated>
      <n-tab-pane name="info" :tab="t('common.info')" display-directive="show">
        <!-- 在线匹配 -->
        <n-flex class="match" justify="space-between" align="center">
          <n-text>{{ t("modal.auto_match_tag_tip") }}</n-text>
          <n-button type="primary" strong secondary @click="onlineMatch">
            <template #icon>
              <SvgIcon name="AutoFix" />
            </template>
            {{ t("modal.auto_match_tag") }}
          </n-button>
        </n-flex>
        <n-scrollbar class="scrollbar">
          <n-form ref="infoFormRef" :model="infoFormData" :rules="infoFormRules" class="phone-form">
            <n-form-item :label="t('common.filename')" path="fileName">
              <n-input v-model:value="infoFormData.filename" disabled />
            </n-form-item>
            <n-form-item :label="t('common.song_name')" path="name">
              <n-input
                v-model:value="infoFormData.name"
                :placeholder="t('modal.song_name_placeholder')"
                clearable
              />
            </n-form-item>
            <n-form-item :label="t('common.artist')" path="artist">
              <n-dynamic-tags
                v-model:value="infoFormData.artists"
                :placeholder="t('modal.artist_placeholder')"
              />
            </n-form-item>
            <n-form-item :label="t('common.album')" path="album">
              <n-input
                v-model:value="infoFormData.album"
                :placeholder="t('modal.album_placeholder')"
                clearable
              />
            </n-form-item>
            <n-form-item :label="t('common.alias')" path="alia">
              <n-input
                v-model:value="infoFormData.alia"
                :placeholder="t('modal.alias_placeholder')"
                clearable
              />
            </n-form-item>
            <n-form-item :label="t('common.lyrics')" path="lyric">
              <n-input
                v-model:value="infoFormData.lyrics"
                :autosize="{ minRows: 3, maxRows: 6 }"
                :placeholder="t('modal.lyrics_placeholder')"
                type="textarea"
              />
            </n-form-item>
            <n-grid :cols="24" :x-gap="24">
              <n-form-item-gi :span="12" :label="t('common.type')" path="type">
                <n-input v-model:value="infoFormData.type" disabled />
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.bitrate')" path="br">
                <n-input-number
                  v-model:value="infoFormData.bitrate"
                  :show-button="false"
                  style="width: 100%"
                  disabled
                >
                  <template #suffix>
                    <n-text depth="3"> kbps </n-text>
                  </template>
                </n-input-number>
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.duration')" path="duration">
                <n-input-number
                  v-model:value="infoFormData.duration"
                  :show-button="false"
                  style="width: 100%"
                  disabled
                >
                  <template #suffix>
                    <n-text depth="3"> s </n-text>
                  </template>
                </n-input-number>
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.sample_rate')" path="br">
                <n-input-number
                  v-model:value="infoFormData.sampleRate"
                  :show-button="false"
                  style="width: 100%"
                  disabled
                >
                  <template #suffix>
                    <n-text depth="3"> Hz </n-text>
                  </template>
                </n-input-number>
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.path')" path="path">
                <n-input-group>
                  <n-input :value="song.path" disabled />
                  <n-button type="primary" ghost @click="copyData(song.path)">
                    <template #icon>
                      <SvgIcon name="Copy" />
                    </template>
                  </n-button>
                </n-input-group>
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.bits_per_sample')" path="br">
                <n-input-number
                  v-model:value="infoFormData.bitsPerSample"
                  :show-button="false"
                  style="width: 100%"
                  disabled
                >
                  <template #suffix>
                    <n-text depth="3"> bit </n-text>
                  </template>
                </n-input-number>
              </n-form-item-gi>
              <n-form-item-gi :span="12" label="MD5" path="md5">
                <n-input-group>
                  <n-input :value="infoFormData.md5" disabled />
                  <n-button type="primary" ghost @click="copyData(infoFormData.md5)">
                    <template #icon>
                      <SvgIcon name="Copy" />
                    </template>
                  </n-button>
                </n-input-group>
              </n-form-item-gi>
            </n-grid>
          </n-form>
        </n-scrollbar>
      </n-tab-pane>
      <n-tab-pane name="cover" :tab="t('common.cover')" display-directive="show">
        <n-image
          :src="coverData"
          :preview-disabled="true"
          width="300"
          height="300"
          class="cover"
          @click="changeCover"
        />
        <n-flex class="menu" justify="center">
          <n-text depth="3">
            {{ t("modal.click_to_change_cover") }}
          </n-text>
        </n-flex>
      </n-tab-pane>
    </n-tabs>
    <n-flex class="menu" justify="center">
      <n-button class="btn" strong secondary @click="emit('close')">
        {{ t("common.cancel") }}
      </n-button>
      <n-button class="btn" type="primary" @click="saveSongInfo(song)">
        {{ t("common.save") }}
      </n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import type { FormInst, FormRules } from "naive-ui";
import { useDataStore, useMusicStore, useSettingStore } from "@/stores";
import { useFormRule } from "@/utils/rules";
import { copyData } from "@/utils/helper";
import { matchSong, neteaseSongLyric } from "@/api/song";
import { debounce, isArray, isEmpty, isObject } from "lodash-es";
import blob from "@/utils/blob";
import { formatSongsList } from "@/utils/format";
import type { SongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
import { romaSeparator, transSeparator } from "@/utils/lyric";
const { t } = useI18n();
const { textRule } = useFormRule();
const props = defineProps<{
  song: SongInfo;
}>();

const emit = defineEmits<{
  close: [];
}>();

// 表单类型
interface InfoFormType {
  name: string;
  filename: string;
  artists: string[];
  album: string;
  alia?: string;
  lyrics?: string;
  size?: number;
  cover?: string | null;
  // 时长
  duration?: number;
  // 类型
  type?: string;
  // 码率
  bitrate?: number;
  // 频率
  sampleRate?: number;
  // 位深度
  bitsPerSample?: number;
  // 位置
  path?: string;
  // md5
  md5?: string;
}

const dataStore = useDataStore();
const musicStore = useMusicStore();
const settingStore = useSettingStore();

// 本地歌曲总线
const localEventBus = useEventBus("local");

// 表单数据
const infoFormRef = ref<FormInst | null>(null);
const infoFormData = ref<InfoFormType>({ name: "", filename: "", artists: [], album: "" });
const infoFormRules: FormRules = { name: textRule };

// 封面数据
const coverData = ref<string>("/images/song.jpg?asset");

// 获取音乐元信息
const getSongInfo = async () => {
  if (!props.song || !props.song.path) return;
  const path = props.song.path;
  const {
    filename,
    name,
    artists,
    album,
    alia,
    lyrics,
    codec,
    duration,
    bitrate,
    sampleRate,
    bitsPerSample,
    size,
    pictures,
    md5,
  } = await window.electron.ipcRenderer.invoke("get-music-metadata", path); // 解构数据
  // 更新数据
  infoFormData.value = {
    filename: String(filename),
    name: String(name ?? ""),
    artists: artists || [],
    album: String(album ?? ""),
    alia: String(alia ?? ""),
    lyrics: String(lyrics ?? ""),
    type: String(codec),
    duration: duration || 0,
    size: size,
    bitrate: bitrate || 0,
    sampleRate: sampleRate,
    bitsPerSample: bitsPerSample,
    md5: String(md5),
  };

  // 获取封面
  const coverBuff = pictures?.[0]?.data || "";
  const coverType = pictures?.[0]?.format || "";

  if (coverBuff) coverData.value = blob.createBlobURL(coverBuff as ArrayBuffer, coverType, path);
};

// 在线匹配
const onlineMatch = debounce(
  async () => {
    try {
      if (!props.song || !infoFormData.value.md5) return;
      const { result } = await matchSong(
        infoFormData.value.name || "",
        infoFormData.value.artists.join(" / ") || "",
        infoFormData.value.album || "",
        infoFormData.value.duration || 0,
        infoFormData.value.md5,
      );
      const song = result.songs?.[0];
      if (isEmpty(song)) {
        window.$message.error(t("message.match_fail"));
        return;
      } else {
        const songData = formatSongsList([song])[0];
        // console.log(songData);
        // 更新数据
        infoFormData.value = {
          ...infoFormData.value,
          name: songData.name,
          artists: isArray(songData.artists)
            ? songData.artists.map((ar: { name: string }) => ar.name)
            : [songData.artists],
          album: isObject(songData.album) ? songData.album.name : songData.album,
          alia: songData.alia,
        };
        // 获取歌词
        const result = await neteaseSongLyric(songData.id);
        infoFormData.value.lyrics = [
          result.lrc.lyric,
          settingStore.downloadLyric && settingStore.downloadLyricTran && result.tlyric?.lyric
            ? [transSeparator, result.tlyric?.lyric].join("\n")
            : "",
          settingStore.downloadLyric && settingStore.downloadLyricRoma && result.romalrc?.lyric
            ? [romaSeparator, result.romalrc?.lyric].join("\n")
            : "",
        ]

          .filter((item) => !!item)
          .join("\n\n");

        if (songData.coverSize?.l) {
          coverData.value = songData.coverSize?.l;
        }

        window.$message.success(t("message.match_success"));
      }
    } catch (error) {
      console.error("Error online matching:", error);
      window.$message.error(t("message.match_fail"));
    }
  },
  300,
  { leading: true, trailing: false },
);

// 修改封面
const changeCover = async () => {
  const newPath = await window.electron.ipcRenderer.invoke("choose-image");
  if (!newPath) return;
  coverData.value = `file://${newPath}`;
};

// 实时修改列表
const updatePlaySong = (metadata: InfoFormType) => {
  // 更新数据
  const updatedSong = {
    name: metadata.name,
    artists: metadata.artists.join(" / "),
    album: metadata.album,
    alia: metadata.alia,
    cover: coverData.value || "",
  };
  // 是否为当前播放
  if (musicStore.playSong?.id === props.song.id) {
    musicStore.playSong = { ...musicStore.playSong, ...updatedSong };
  }
  // 更改播放列表
  const index = dataStore.playList.findIndex((song) => song.id === props.song.id);
  if (index !== -1) {
    dataStore.playList[index] = { ...dataStore.playList[index], ...updatedSong };
  }
  // 更新列表
  localEventBus.emit();
};

// 保存修改
const saveSongInfo = debounce(async (song: SongInfo) => {
  try {
    if (!song.path) return;
    if (!infoFormRef.value) return;
    // 校验表单
    await infoFormRef.value?.validate();
    // 保存修改
    const metadata = {
      ...infoFormData.value,
      artists: infoFormData.value.artists.slice(),
      cover:
        coverData.value.startsWith("blob:") || coverData.value === "/images/song.jpg?asset"
          ? null
          : coverData.value.startsWith("file://")
            ? coverData.value.replace(/^file:\/\//, "")
            : coverData.value,
    };
    await window.electron.ipcRenderer.invoke("set-music-metadata", song.path, metadata);
    window.$message.success(t("message.song_info_modify_success"));

    // 更新cover
    if (metadata.cover) {
      blob.revokeBlobURL(song.path);
      const coverData = await window.electron.ipcRenderer.invoke("get-music-cover", song.path);
      if (!coverData) return;
      const { data, format } = coverData;
      const blobURL = blob.createBlobURL(data, format, song.path);
      if (blobURL) metadata.cover = blobURL;
    }
    // 修改音乐信息
    updatePlaySong(metadata);
    emit("close");
  } catch (error) {
    console.error("Error saving song info:", error);
    window.$message.error(t("message.song_info_modify_fail"));
  }
}, 300);

onMounted(getSongInfo);
</script>

<style lang="scss" scoped>
.song-info-editor {
  :deep(.scrollbar) {
    max-height: 60vh;
  }
  .cover {
    display: flex;
    justify-content: center;
    border-radius: 16px;
    margin: 20px auto 0;
    cursor: pointer;
  }
  .match {
    margin-bottom: 12px;
    border: 1px solid rgba(var(--primary), 0.26);
    border-radius: 8px;
    padding: 12px 16px;
    background-color: rgba(var(--primary), 0.08);
  }
  .menu {
    width: 100%;
    margin-top: 20px;
  }
}
</style>
