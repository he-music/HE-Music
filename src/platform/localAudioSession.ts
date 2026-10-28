import { watch } from "vue";
import { filesSession, type LocalAudioAccess } from "./filesSession";
import type { LocalFileRef } from "./mygo.bindings";
import { localFilesSession } from "./localFilesSession";

const writeBlocks = new Set<symbol>();
const audioSessions = new Set<LocalAudioSession>();

/** Pause local sources before a file write; each owner releases only its own gate. */
export function blockLocalAudio(): () => void {
  const token = Symbol("local-file-write");
  writeBlocks.add(token);
  const release = () => {
    writeBlocks.delete(token);
  };
  let failure: { error: unknown } | undefined;
  for (const session of audioSessions) {
    try {
      session.clear();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) {
    release();
    throw failure.error;
  }
  return release;
}
function registered(ref: LocalFileRef): boolean {
  return (
    localFilesSession.value?.entries.value.some(
      (entry) =>
        entry.ref.fileId === ref.fileId &&
        entry.ref.version === ref.version &&
        entry.ref.grantToken === ref.grantToken &&
        entry.ref.relativePath === ref.relativePath,
    ) ?? false
  );
}

/** Owns one player's current local ticket; late URLs are closed before use. */
export class LocalAudioSession {
  private revision = 0;
  private ticket?: { access: LocalAudioAccess; id: string; ref: LocalFileRef };
  private readonly stop: () => void;
  private disposed = false;

  constructor(private readonly invalidate: () => void) {
    audioSessions.add(this);
    this.stop = watch(
      () => [
        filesSession.value,
        filesSession.value?.ready.value,
        filesSession.value?.directories.value,
        localFilesSession.value?.entries.value,
      ],
      () => {
        if (this.ticket && !this.active) this.clear();
      },
      { flush: "sync" },
    );
  }

  get active(): boolean {
    const ticket = this.ticket;
    return Boolean(!writeBlocks.size && ticket?.access.current() && registered(ticket.ref));
  }

  clear(): void {
    this.revision++;
    const ticket = this.ticket;
    this.ticket = undefined;
    if (ticket) {
      try {
        this.invalidate();
      } finally {
        void ticket.access.close(ticket.id).catch(() => {});
      }
    }
  }

  async open(ref: LocalFileRef): Promise<string | null> {
    this.clear();
    if (this.disposed || writeBlocks.size) return null;
    const revision = this.revision;
    const access = filesSession.value?.audioAccess(ref);
    if (!access) throw new Error("Local audio is unavailable");
    const ticket = await access.open();
    if (
      this.disposed ||
      writeBlocks.size ||
      revision !== this.revision ||
      !access.current() ||
      !registered(ref)
    ) {
      await access.close(ticket.ticketId).catch(() => {});
      return null;
    }
    let valid = false;
    try {
      const url = new URL(ticket.url);
      valid =
        ticket.version === ref.version &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        Boolean(url.port) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === `/${ticket.ticketId}`;
    } catch {
      // Invalid URLs still belong to this request and must be released.
    }
    if (!valid) {
      await access.close(ticket.ticketId).catch(() => {});
      throw new Error("Invalid local audio ticket");
    }
    this.ticket = { access, id: ticket.ticketId, ref };
    return ticket.url;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.clear();
    } finally {
      audioSessions.delete(this);
      this.stop();
    }
  }
}
