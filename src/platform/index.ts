import { isMyGo } from "mygo-runtime";
import { createMygoPlatform } from "./mygo";
import { createWebPlatform } from "./web";

export const platform = isMyGo() ? createMygoPlatform() : createWebPlatform();
