import { mygoGatewayOrigin } from "./gateway";
import type { ScanEntry } from "./mygo.bindings";

const pageRevision = Math.random().toString(36).slice(2);
const revisions = new WeakMap<ScanEntry, number>();
let revision = 0;

/** A rescan refreshes sidecars even when the audio file itself has not changed. */
export function localResourceURL(
  kind: "audio" | "artwork" | "lyrics",
  entry: ScanEntry | undefined,
): string | undefined {
  const gateway = mygoGatewayOrigin();
  if (!gateway || !entry?.path) return undefined;
  let current = revisions.get(entry);
  if (current === undefined) {
    current = ++revision;
    revisions.set(entry, current);
  }
  const query = new URLSearchParams({ path: entry.path, v: `${pageRevision}-${current}` });
  return `${gateway}/__local/${kind}?${query}`;
}

export async function readLocalLyrics(entry: ScanEntry): Promise<string> {
  const url = localResourceURL("lyrics", entry);
  if (!url) return "";
  const response = await fetch(url, { credentials: "omit" });
  return response.ok ? response.text() : "";
}
