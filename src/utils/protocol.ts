import { songInfo } from "@/api/song";
import { usePlayer } from "@/utils/player";

class OrpheusData {
  constructor(type: string, id: string, cmd: string) {
    this.type = type;
    this.id = id;
    this.cmd = cmd;
  }

  type: string;
  id: string;
  cmd: string;
}

export const handleProtocolUrl = (url: string) => {
  // QQ音乐
  // qqmusicmac://QQMusic/?version==1173&&from==y.qq.com&&cmd_count==1&&cmd_0==downloadsong&&id_0==628753930|622029054&&songtype_0==0|0&&info_0==&&quality_0==quality
  // 酷狗音乐
  // mackugou://download?p=eyJGaWxlcyI6W3siZmlsZW5hbWUiOiLml7bku6PlsJHlubTlm6It5Yas5pel5p2l5L+hwqAoV2ludGVywqBMb3ZlwqBMZXR0ZXIpLm1wMyIsImhhc2giOiJCQ0E5N0Q3RkFFRkJFRjI4OTZGODdDMEExRUZEQkQ2NCIsInNpemUiOiI0MTAwNDY1IiwiZHVyYXRpb24iOiIyNTYwMDAiLCJiaXRyYXRlIjoiMTI4IiwiaXNmaWxlaGVhZCI6IjEwMCIsInByaXZpbGVnZSI6IjgiLCJhbGJ1bV9pZCI6IjE3MTE5NDQyNyJ9XX0=
  switch (true) {
    case url.startsWith("orpheus://"):
      handleOpenOrpheus(url);
      break;
    case url.startsWith("kuwo://"):
      handleOpenKuwo(url);
      break;
    default:
      break;
  }
};

export const handleOpenKuwo = async (url: string) => {
  console.log("🚀 Open kuwo:", url);
  try {
    const urlObj = new URL(url);
    const musicrid0 = atob(urlObj.searchParams.get("musicrid0") || "");
    const id = musicrid0.replace("MUSIC_", "");
    const player = usePlayer();
    let result: any;
    switch (urlObj.hostname) {
      case "play":
        result = await songInfo("kuwo", id);
        player.addNextSong(result?.list[0], true);
        break;
      default:
        console.log("❌ Unsupported Command or Type:", urlObj.hostname);
        break;
    }
  } catch {
    console.error("❌ Invalid URL:", url);
  }
};

export const handleOpenOrpheus = async (url: string) => {
  const data = parseOrpheus(url);
  if (!data) return;
  console.log("🚀 Open Orpheus:", data);

  if (data.cmd === "play" && data.type === "song") {
    const player = usePlayer();
    const result = await songInfo("netease", data.id);
    player.addNextSong(result?.list[0], true);
  } else {
    console.log("❌ Unsupported Command or Type:", data);
  }
};

const parseOrpheus = (url: string): OrpheusData | undefined => {
  // 这里的协议是从网页端打开官方客户端的协议
  // 形如 `orpheus://eyJ0eXBlIjoic29uZyIsImlkIjoiMTgyNjM2MTcxMiIsImNtZCI6InBsYXkifQ==`
  // URI 的 Path 部分是 Base64 编码过的，解码后得到 Json
  // 形如 `{"type":"song","id":"1826361712","cmd":"play"}`

  if (!url.startsWith("orpheus://")) return;
  let path = url.replace("orpheus://", "");
  // 移除末尾可能存在的斜杠
  if (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  // 尝试 URL 解码
  try {
    path = decodeURIComponent(path);
  } catch (e) {
    console.warn("URL Decode failed, using original path:", e);
  }
  // 处理 URL-safe Base64
  path = path.replace(/-/g, "+").replace(/_/g, "/");
  // 补全 Base64 填充
  const padding = path.length % 4;
  if (padding > 0) {
    path += "=".repeat(4 - padding);
  }
  let jsonString: string;
  try {
    jsonString = atob(path);
  } catch (e) {
    console.error("❌ Failed to decode base64:", path, e);
    return;
  }
  let data: OrpheusData;
  try {
    const json = JSON.parse(jsonString);
    data = new OrpheusData(json.type, json.id, json.cmd);
  } catch (e) {
    console.error("❌ Invalid Data:", e);
    return;
  }
  return data;
};
