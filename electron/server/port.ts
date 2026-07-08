import getPort from "get-port";

// 默认端口
let webPort: number;
let servePort: number;

const getSafePort = async () => {
  if (webPort && servePort) return { webPort, servePort };
  webPort = await getPort({ port: 14666 });
  servePort = await getPort({ port: 25666 });
  return { webPort, servePort };
};

export default getSafePort;
