import { FastifyInstance } from "fastify";
import mainWindow from "../../main/windows/main-window";
import { serverLog } from "../../main/logger";

const loginFailTxt = `
  <!DOCTYPE html>
  <html lang="zh">
  <head>
    <meta charset="UTF-8">
    <title>Login Status</title>
  </head>
  <body>
    <h1>Login fail!</h1>
    <script>
      alert("Login fail!");
    </script>
  </body>
  </html>
`;

const loginSuccessTxt = `
  <!DOCTYPE html>
  <html lang="zh">
  <head>
    <meta charset="UTF-8">
    <title>Login Status</title>
  </head>
  <body>
    <h1>登录成功！</h1>
    <p>请手动关闭此窗口</p>
    <script>
      alert("登录成功！");
      window.close();
    </script>
  </body>
  </html>
`;

// 初始化 登录回调
export const initLoginAPI = async (fastify: FastifyInstance) => {
  fastify.get("/success", async (req, reply) => {
    const { state } = req.query as { state?: string };
    if (!state) {
      serverLog.error("❌ OAuth callback missing state parameter");
      reply.type("text/html").send(loginFailTxt);
      return;
    }
    // 转发 state 给渲染进程，由渲染进程兑换 token
    const mainWin = mainWindow.getWin();
    mainWin?.webContents.send("login-success", { state });
    reply.type("text/html").send(loginSuccessTxt);
  });

  serverLog.info("🌐 Register LoginAPI successfully");
};
