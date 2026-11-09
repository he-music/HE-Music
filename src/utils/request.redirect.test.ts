import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/utils/env", () => ({ isDev: false }));
vi.mock("@/stores", () => ({
  useDataStore: () => ({ token: "", refreshToken: "", userLoginStatus: false }),
  useSettingStore: () => ({ language: "zh-CN", proxyProtocol: "off" }),
}));
vi.mock("@/utils/modal", () => ({ openCaptcha: vi.fn(), openUserLogin: vi.fn() }));
vi.mock("@/api/auth", () => ({ refreshTokenApi: vi.fn() }));
vi.mock("@/utils/device", () => ({ getDeviceInfo: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("真实fetch传输仅向后端发送实例Header，拒绝跟随跨域redirect", async () => {
  let externalCalls = 0;
  const external = await listen(
    createServer((_, response) => {
      externalCalls++;
      response.end("unexpected");
    }),
  );
  const received: unknown[] = [];
  const backend = await listen(
    createServer((request, response) => {
      received.push(request.headers["x-client-instance-id"]);
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: `${external}/media` });
        response.end();
      } else {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ list: [] }));
      }
    }),
  );
  vi.stubEnv("VITE_API_URL", backend);
  vi.stubGlobal("window", { $message: { error: vi.fn() } });
  vi.resetModules();
  const { requestHemusic } = await import("./request");
  await expect(requestHemusic({ url: "/v1/platforms" })).resolves.toEqual({ list: [] });
  await expect(requestHemusic({ url: "/redirect" })).rejects.toBeDefined();
  expect(received).toHaveLength(2);
  expect(received[0]).toMatch(/^[!-~]{1,128}$/);
  expect(received[1]).toBe(received[0]);
  expect(externalCalls).toBe(0);
});
