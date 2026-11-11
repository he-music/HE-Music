import { getCoverUrlStr } from "@/api/song";
import { gatewayAPIUrl, gatewayProxyUrl, isMygoGatewayResourceUrl } from "./gateway";
import { loadSystemMediaArtwork } from "./systemMediaArtwork";
import type { MetadataMatchCandidate } from "./localMetadataMatch";
import type { Picture } from "./mygo.bindings";

export async function loadMetadataMatchArtwork(
  option: MetadataMatchCandidate,
  imageSizes: number[],
  token: string,
  canGetCover: boolean,
  signal: AbortSignal,
): Promise<Picture | undefined> {
  const sizes = imageSizes.filter((size) => Number.isInteger(size) && size > 0 && size <= 2048);
  const size = sizes.find((value) => value >= 1024) ?? sizes.at(-1) ?? 1024;
  // A template with no supported size inside the loader budget cannot be safely requested.
  if (imageSizes.length && !sizes.length) return;
  let source: string;
  if (option.cover) {
    const cover = new URL(
      option.cover.replaceAll("{x}", String(size)).replaceAll("{y}", String(size)),
    );
    if (!/^https?:$/.test(cover.protocol) || cover.username || cover.password)
      throw new Error("Unsupported match artwork");
    source = gatewayProxyUrl(cover.href);
    if (!isMygoGatewayResourceUrl(source))
      throw new Error("Match artwork requires the controlled gateway");
  } else {
    if (!canGetCover) return;
    // Fixed HE-Music API routing also supports a configured localhost backend.
    source = gatewayAPIUrl(getCoverUrlStr(option.platform, option.id, size, true, token));
  }
  const data = await loadSystemMediaArtwork(source, signal);
  const mime = atob(data).startsWith("\x89PNG") ? "image/png" : "image/jpeg";
  return { MIME: mime, Type: 3, Description: "", Data: data };
}
