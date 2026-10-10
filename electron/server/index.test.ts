import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import type { FastifyInstance } from "fastify";

const mocks = vi.hoisted(() => ({
  staticRegistration: vi.fn(),
  root: "",
  send: vi.fn(),
  upstream: vi.fn(async (parameters: Record<string, unknown>) => ({
    status: 200,
    body: { code: 200, parameters },
  })),
}));
vi.mock("@fastify/static", async () => {
  const actual = await vi.importActual<typeof import("@fastify/static")>("@fastify/static");
  const plugin: typeof actual.default = (server, options) => {
    mocks.staticRegistration(options);
    return actual.default(server, { ...options, root: mocks.root });
  };
  // 保留插件 metadata；测试只替换静态文件夹为隔离 fixture。
  return { default: Object.assign(plugin, actual.default) };
});
vi.mock("../main/utils/config", () => ({
  isDev: false,
  port: 0,
  appVersion: "test",
  appName: "HE-Music",
}));
vi.mock("../main/logger", () => ({
  serverLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));
vi.mock("../main/windows/main-window", () => ({
  default: { getWin: () => ({ webContents: { send: mocks.send } }) },
}));
vi.mock("@neteasecloudmusicapienhanced/api", () => ({
  default: { echo: mocks.upstream },
}));

import initAppServer from "./index";

describe("生产 Fastify 静态服务", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    mocks.root = await mkdtemp(join(tmpdir(), "he-music-static-test-"));
    await mkdir(join(mocks.root, "web/loading"), { recursive: true });
    await mkdir(join(mocks.root, "assets"));
    await mkdir(join(mocks.root, "api"));
    await mkdir(join(mocks.root, "login"));
    await writeFile(join(mocks.root, "index.html"), "<html>renderer</html>");
    await writeFile(join(mocks.root, "web/loading/index.html"), "<html>loading</html>");
    await writeFile(join(mocks.root, "assets/App.js"), "export const app = true;");
    // 制造与API路由同名的静态文件，验证静态 wildcard 不抢占业务路由。
    await writeFile(join(mocks.root, "api/netease"), "static collision");
    await writeFile(join(mocks.root, "login/success"), "static collision");
    // 仅监听本测试拥有的随机端口，不占用真实应用端口。
    vi.stubEnv("VITE_SERVER_PORT", "0");
    server = await initAppServer();
    await server.ready();
  });

  afterAll(async () => {
    if (server) await server.close();
    vi.unstubAllEnvs();
    if (mocks.root) await rm(mocks.root, { recursive: true, force: true });
  });

  it("生产入口实际注册 static，root 保持绝对 renderer 路径", () => {
    expect(mocks.staticRegistration).toHaveBeenCalledOnce();
    const options = mocks.staticRegistration.mock.calls[0][0];
    expect(isAbsolute(options.root)).toBe(true);
    expect(options.root).toMatch(/[/\\]renderer$/);
  });

  it.each([
    ["/", "<html>renderer</html>", "text/html"],
    ["/web/loading/index.html", "<html>loading</html>", "text/html"],
    ["/assets/App.js", "export const app = true;", "javascript"],
  ])("服务真实HTML/资产：%s", async (url, body, contentType) => {
    const response = await server.inject(url);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers["content-type"]).toContain(contentType);
  });

  it.each(["/assets/missing.js", "/api/unknown"])("不存在的资源返回404：%s", async (url) => {
    const response = await server.inject(url);
    expect(response.statusCode).toBe(404);
  });

  it("拒绝大小写不匹配的资产路径", async () => {
    const response = await server.inject("/assets/app.js");
    expect([403, 404]).toContain(response.statusCode);
  });

  it("API路由和登录回调优先于静态资源", async () => {
    expect((await server.inject("/api")).json().name).toBe("SPlayer API");
    expect((await server.inject("/api/netease")).json().name).toBe("@neteaseapireborn/api");
    expect((await server.inject("/api/unblock")).json().name).toBe("UnblockAPI");
    expect((await server.inject("/api/control/status")).json().data.connected).toBe(true);
    const response = await server.inject("/login/success?state=test-state");
    expect(response.body).toContain("登录成功");
    expect(response.body).not.toContain("static collision");
    expect(mocks.send).toHaveBeenCalledWith("login-success", { state: "test-state" });
  });

  it("multipart默认注册保持JSON POST和cookie透传语义", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/netease/echo?query=value",
      headers: { cookie: "token=abc" },
      payload: { field: "body-value" },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.upstream).toHaveBeenCalledWith({
      query: "value",
      field: "body-value",
      cookie: { token: "abc" },
    });
  });
});
