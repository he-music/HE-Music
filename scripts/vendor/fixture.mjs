// 仅用于离线 Node 测试：最小 vendor 夹具不会调用 Go 或构建应用。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createVendorLock, SDK_WINDOWS_FILE } from "./mygo.mjs";

export async function vendorFixture(root) {
  const definition = await readFile(new URL("../../patches/mygo/patch.json", import.meta.url));
  const source = await readFile(new URL(`../../vendor/${SDK_WINDOWS_FILE}`, import.meta.url));
  await mkdir(path.join(root, "patches/mygo"), { recursive: true });
  await mkdir(path.dirname(path.join(root, "vendor", SDK_WINDOWS_FILE)), { recursive: true });
  await writeFile(path.join(root, "patches/mygo/patch.json"), definition);
  await writeFile(path.join(root, "go.sum"), "");
  await writeFile(path.join(root, "vendor", SDK_WINDOWS_FILE), source);
  await writeFile(path.join(root, "vendor/fixture.txt"), "offline dependency fixture\n");
  const lock = await createVendorLock(root);
  await writeFile(path.join(root, "patches/mygo/vendor-lock.json"), JSON.stringify(lock));
  return { source, definition: JSON.parse(definition), lock };
}
