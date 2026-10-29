export type PreferencesResetMode = "settings" | "all";

export interface PreferencesResetReceipt {
  pending: boolean;
  transactionId: string;
  mode: PreferencesResetMode;
  restartRequired: boolean;
}

export interface PlatformPreferencesReset {
  reset(mode: PreferencesResetMode): Promise<PreferencesResetReceipt>;
}

export type PreferencesResetResult =
  | { status: "native-failed" }
  | { status: "stale"; nativePending: boolean }
  | { status: "scheduled"; rendererFailed: boolean; quitFailed: boolean };

/** The durable native commit must precede every destructive renderer action. */
export async function executePreferencesReset(deps: {
  mode: PreferencesResetMode;
  native: PlatformPreferencesReset;
  current(): boolean;
  clearRenderer(): Promise<void>;
  quit(): Promise<void>;
  reportRendererFailure(): void;
}): Promise<PreferencesResetResult> {
  if (!deps.current()) return { status: "stale", nativePending: false };
  try {
    const receipt = await deps.native.reset(deps.mode);
    if (
      !receipt.pending ||
      !receipt.restartRequired ||
      !receipt.transactionId ||
      receipt.mode !== deps.mode
    )
      return { status: "native-failed" };
  } catch {
    return { status: "native-failed" };
  }
  if (!deps.current()) return { status: "stale", nativePending: true };
  let rendererFailed = false;
  try {
    await deps.clearRenderer();
  } catch {
    if (!deps.current()) return { status: "stale", nativePending: true };
    rendererFailed = true;
    deps.reportRendererFailure();
  }
  if (!deps.current()) return { status: "stale", nativePending: true };
  try {
    await deps.quit();
    return { status: "scheduled", rendererFailed, quitFailed: false };
  } catch {
    return { status: "scheduled", rendererFailed, quitFailed: true };
  }
}
