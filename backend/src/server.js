import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.port, env.host, () => {
  console.log(`Backend API running at ${env.backendUrl} on ${env.host}:${env.port}`);
});

server.requestTimeout = 180_000;
server.headersTimeout = 185_000;
server.keepAliveTimeout = 5_000;
