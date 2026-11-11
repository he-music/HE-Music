import { afterEach, expect, it, vi } from "vitest";
import { defineComponent, h, ref, shallowRef } from "vue";
import {
  emitHostEvent,
  flushSfcHost,
  mountProductionSfc,
  type SfcHostNode,
} from "@/test/productionSfc";
import { localEntry, localSong } from "@/test/fixtures/localMedia";
import type { SongInfo } from "@/types/main.hemusic";

const song = (id: string): SongInfo => ({
  ...localSong(localEntry()),
  id: `mygo-local:${id}`,
  name: id,
});
const available = song("available");
const missing = song("missing");
const currentSongs = shallowRef([available]);
const route = shallowRef({ name: "local-playlist", query: { id: "first" } });
const playlists = shallowRef([
  {
    id: "first",
    name: "本地歌单",
    cover: "",
    description: "歌单简介",
    songs: [available, missing],
  },
  { id: "second", name: "另一歌单", cover: "", description: "", songs: [missing] },
]);
const store = {
  get playlists() {
    return playlists.value;
  },
  ready: true,
  failed: false,
  load: vi.fn().mockResolvedValue(undefined),
};
const updatePlayList = vi.fn();
const edit = vi.fn();
let close: (() => void) | undefined;
const Stub = defineComponent({
  inheritAttrs: false,
  setup:
    (_props, { attrs, slots }) =>
    () =>
      h("stub", attrs, slots.default?.()),
});
const SongList = defineComponent({
  inheritAttrs: false,
  setup:
    (_props, { attrs }) =>
    () =>
      h("SongList", attrs),
});
const text = (node: SfcHostNode): string => node.text + node.children.map(text).join("");

function mount() {
  const host = mountProductionSfc(
    new URL("./localplaylist.vue", import.meta.url),
    {
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "vue-router": { useRouter: () => ({ currentRoute: route, push: vi.fn(), replace: vi.fn() }) },
      "naive-ui": { NSelect: Stub },
      "@/components/Page/AsyncContent.vue": { default: Stub },
      "@/components/Page/MobileMusicDetailHeader.vue": { default: Stub },
      "@/components/List/SongList.vue": { default: SongList },
      "@/composables/useMusicDetailLayout": {
        useMusicDetailLayout: () => ({ isSmallScreen: ref(false), detailPageRef: () => {} }),
      },
      "@/composables/useSongSearch": { useSongSearch: () => ref([]) },
      "@/composables/useLibrarySync": { useLibrarySync: () => {} },
      "@/stores/localPlaylists": { useLocalPlaylistStore: () => store },
      "@/stores/status": { useStatusStore: () => ({ mainContentHeight: 700 }) },
      "@/platform/localFilesSession": { localFilesSession: shallowRef(undefined) },
      "@/platform/librarySongRows": { createLibrarySongRows: () => currentSongs },
      "@/platform/gateway": { gatewayProxyUrl: (url: string) => url },
      "@/utils/helper": { coverLoaded: () => {}, renderIcon: () => () => null },
      "@/utils/modal": {
        openBatchList: vi.fn(),
        openDescModal: vi.fn(),
        openUpdateLocalPlaylist: edit,
      },
      "@/utils/meta": { renderToolbar: () => null },
      "@/utils/time": { formatTimestamp: () => "2026" },
      "@/utils/player": { usePlayer: () => ({ updatePlayList }) },
    },
    [
      "NH2",
      "NImage",
      "NSkeleton",
      "NCollapseTransition",
      "NText",
      "NFlex",
      "NButton",
      "NDropdown",
      "NInput",
      "NEmpty",
      "NTag",
      "SvgIcon",
    ],
  );
  close = host.close;
  return host;
}

afterEach(() => {
  close?.();
  close = undefined;
  currentSongs.value = [available];
  route.value = { name: "local-playlist", query: { id: "first" } };
  vi.clearAllMocks();
});

it("失效文件保留在歌曲列表，播放队列只包含当前可用文件，恢复后可直接播放", async () => {
  const host = mount();
  const list = () => host.all().find((node) => node.tag === "SongList")!;
  expect(list().props.data).toEqual([available, missing]);
  expect(list().props["unavailable-song-ids"]).toEqual(new Set([missing.id]));
  const play = host
    .all()
    .find((node) => node.tag === "NButton" && text(node).includes("common.play"))!;
  emitHostEvent(play, "onClick");
  expect(updatePlayList).toHaveBeenLastCalledWith([available], undefined, {
    id: "first",
    platform: "",
    type: "local-playlist",
  });
  currentSongs.value = [available, missing];
  await flushSfcHost();
  expect(list().props["unavailable-song-ids"]).toEqual(new Set());
  emitHostEvent(play, "onClick");
  expect(updatePlayList).toHaveBeenLastCalledWith([available, missing], undefined, {
    id: "first",
    platform: "",
    type: "local-playlist",
  });
});

it("侧栏切换到另一本地歌单时，详情、播放范围和编辑对象同步更新", async () => {
  const host = mount();
  route.value = { name: "local-playlist", query: { id: "second" } };
  await flushSfcHost();
  expect(host.all().some((node) => node.text === "另一歌单")).toBe(true);
  const list = host.all().find((node) => node.tag === "SongList")!;
  expect(list.props.data).toEqual([missing]);
  expect(list.props.playlist).toMatchObject({ id: "second", type: "local-playlist" });
  const button = host
    .all()
    .find((node) => node.tag === "NButton" && text(node).includes("common.edit"))!;
  emitHostEvent(button, "onClick");
  expect(edit).toHaveBeenCalledWith(playlists.value[1]);
});
