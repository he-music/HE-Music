import { platform } from "@/platform";
import { bootstrapWindow } from "./bootstrap/window";

void bootstrapWindow(platform.kind, location.hash).catch((error: unknown) => {
  console.error("应用初始化失败", error);
});
