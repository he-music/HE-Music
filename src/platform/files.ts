import type { NativeFiles } from "./mygo.bindings";

/** Picker-scoped methods; paths and imported settings never grant filesystem access. */
export interface PlatformFiles {
  begin: typeof NativeFiles.begin;
  chooseDirectory: typeof NativeFiles.chooseDirectory;
  defaultDirectory: typeof NativeFiles.defaultDirectory;
  importSettings: typeof NativeFiles.importSettings;
  exportSettings: typeof NativeFiles.exportSettings;
  revokeDirectory: typeof NativeFiles.revokeDirectory;
  teardown: typeof NativeFiles.teardown;
}
