import type { BindingMethods } from "./bindingMethods";
import type { NativeFiles } from "./mygo.bindings";

type FileMethods = BindingMethods<typeof NativeFiles>;

/** Session-scoped file methods; displayed paths and imported settings never grant filesystem access. */
export interface PlatformFiles {
  begin: FileMethods["begin"];
  chooseDirectory: FileMethods["chooseDirectory"];
  restoreDirectories?: FileMethods["restoreDirectories"];
  forgetSavedDirectory?: FileMethods["forgetSavedDirectory"];
  defaultDirectory: FileMethods["defaultDirectory"];
  importSettings: FileMethods["importSettings"];
  exportSettings: FileMethods["exportSettings"];
  revokeDirectory: FileMethods["revokeDirectory"];
  teardown: FileMethods["teardown"];
  startScan?: FileMethods["startScan"];
  readScanPage?: FileMethods["readScanPage"];
  cancelFileOperation?: FileMethods["cancelFileOperation"];
  readMetadata?: FileMethods["readMetadata"];
  saveMetadata?: FileMethods["saveMetadata"];
  revealLocalFile?: FileMethods["revealLocalFile"];
  removeLocalFile?: FileMethods["removeLocalFile"];
  cancelMetadata?: FileMethods["cancelMetadata"];
  startDownload?: FileMethods["startDownload"];
  readDownloadState?: FileMethods["readDownloadState"];
  cancelDownload?: FileMethods["cancelDownload"];
  forgetDownload?: FileMethods["forgetDownload"];
}
