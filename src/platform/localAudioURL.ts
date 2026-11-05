export function joinLocalFilePath(directory: string, relativePath: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(directory);
  const separator = windows ? "\\" : "/";
  const base = directory.replace(windows ? /[\\/]+$/ : /\/+$/, "");
  return `${base}${separator}${windows ? relativePath.replaceAll("/", "\\") : relativePath}`;
}
