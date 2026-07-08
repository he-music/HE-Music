import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pathCase } from "change-case";
import { serverLog } from "../../main/logger";
import NeteaseCloudMusicApi from "@neteasecloudmusicapienhanced/api";

// 获取数据
const getHandler = (name: string, neteaseApi: (params: any) => any) => {
  return async (
    req: FastifyRequest<{ Querystring: { [key: string]: string } }>,
    reply: FastifyReply,
  ) => {
    serverLog.log("🌐 Request NcmAPI:", name);
    // 获取 NcmAPI 数据
    try {
      const result = await neteaseApi({
        ...req.query,
        ...(req.body as Record<string, any>),
        cookie: req.cookies,
      });
      return reply.send(result.body);
    } catch (error: any) {
      serverLog.error("❌ NcmAPI Error:", error);
      if ([400, 301].includes(error.status)) {
        return reply.status(error.status).send(error.body);
      }
      return reply
        .status(500)
        .send(error.body || { error: error.message || "Internal Server Error" });
    }
  };
};

// 初始化 NcmAPI
export const initNcmAPI = async (fastify: FastifyInstance) => {
  // 主信息
  fastify.get("/netease", (_, reply) => {
    reply.send({
      name: "@neteaseapireborn/api",
      version: "4.29.2",
      description: "网易云音乐 API Enhanced",
      author: "@MoeFurina",
      license: "MIT",
      url: "https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced",
    });
  });

  // 注册 NeteaseCloudMusicApi 所有接口
  Object.entries(NeteaseCloudMusicApi).forEach(([routerName, neteaseApi]: [string, any]) => {
    // 例外
    if (["serveNcmApi", "getModulesDefinitions"].includes(routerName)) return;
    // 路由名称
    const pathName = pathCase(routerName);
    // 获取数据
    const handler = getHandler(pathName, neteaseApi);
    // 注册路由
    fastify.get(`/netease/${pathName}`, handler);
    fastify.post(`/netease/${pathName}`, handler);
    // 兼容路由 - 中间具有 _ 的路由
    if (routerName.includes("_")) {
      fastify.get(`/netease/${routerName}`, handler);
      fastify.post(`/netease/${routerName}`, handler);
    }
  });

  // 获取 TTML 歌词
  fastify.get(
    "/netease/lyric/ttml",
    async (req: FastifyRequest<{ Querystring: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.query;
      if (!id) {
        return reply.status(400).send({ error: "id is required" });
      }
      const url = `https://amll-ttml-db.stevexmh.net/ncm/${id}`;
      try {
        const response = await fetch(url);
        if (response.status !== 200) {
          return reply.send(null);
        }
        const data = await response.text();
        return reply.send(data);
      } catch (error) {
        serverLog.error("❌ TTML Lyric Fetch Error:", error);
        return reply.send(null);
      }
    },
  );

  serverLog.info("🌐 Register NcmAPI successfully");
};
