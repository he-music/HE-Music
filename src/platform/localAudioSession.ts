export interface LocalAudioTarget {
  grantToken: string;
  relativePath: string;
  fileId: string;
}

export type LocalAudioBlockTarget = string | LocalAudioTarget;

const writeBlocks = new Set<symbol>();
let stopLocalAudio: ((target?: LocalAudioBlockTarget) => void | Promise<void>) | undefined;

/** The player owns stopping its source and invalidating a pending local load. */
export function registerLocalAudioStopper(
  stop: (target?: LocalAudioBlockTarget) => void | Promise<void>,
): void {
  stopLocalAudio = stop;
}

export interface LocalAudioRelease {
  (): void;
  readonly ready?: Promise<void>;
}
export function blockLocalAudio(target?: LocalAudioBlockTarget): LocalAudioRelease {
  const token = Symbol("local-file-write");
  writeBlocks.add(token);
  try {
    const ready = Promise.resolve(stopLocalAudio?.(target));
    // 生命周期撤销等同步调用者也会得到失败已处理的 promise；写入者仍 await 原 promise。
    void ready.catch(() => undefined);
    return Object.assign(
      () => {
        writeBlocks.delete(token);
      },
      { ready },
    );
  } catch (error) {
    writeBlocks.delete(token);
    throw error;
  }
}

export function localAudioBlocked(): boolean {
  return writeBlocks.size > 0;
}
