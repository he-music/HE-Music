import type { NativeFiles } from "./mygo.bindings";

/** Session-scoped file methods; displayed paths and imported settings never grant filesystem access. */
export interface PlatformFiles {
  begin: typeof NativeFiles.begin;
  chooseDirectory: typeof NativeFiles.chooseDirectory;
  restoreDirectories?: typeof NativeFiles.restoreDirectories;
  forgetSavedDirectory?: typeof NativeFiles.forgetSavedDirectory;
  defaultDirectory: typeof NativeFiles.defaultDirectory;
  importSettings: typeof NativeFiles.importSettings;
  exportSettings: typeof NativeFiles.exportSettings;
  revokeDirectory: typeof NativeFiles.revokeDirectory;
  teardown: typeof NativeFiles.teardown;
  startScan?: typeof NativeFiles.startScan;
  readScanPage?: typeof NativeFiles.readScanPage;
  cancelFileOperation?: typeof NativeFiles.cancelFileOperation;
  openLocalAudio?: typeof NativeFiles.openLocalAudio;
  closeLocalAudio?: typeof NativeFiles.closeLocalAudio;
  readMetadata?: typeof NativeFiles.readMetadata;
  saveMetadata?: typeof NativeFiles.saveMetadata;
  readLocalArtwork?: typeof NativeFiles.readLocalArtwork;
  readLocalLyrics?: typeof NativeFiles.readLocalLyrics;
  revealLocalFile?: typeof NativeFiles.revealLocalFile;
  removeLocalFile?: typeof NativeFiles.removeLocalFile;
  cancelMetadata?: typeof NativeFiles.cancelMetadata;
  startDownload?: typeof NativeFiles.startDownload;
  readDownloadState?: typeof NativeFiles.readDownloadState;
  cancelDownload?: typeof NativeFiles.cancelDownload;
  forgetDownload?: typeof NativeFiles.forgetDownload;
}
