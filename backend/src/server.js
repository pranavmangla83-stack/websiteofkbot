import { app } from "./app.js";
import { env } from "./config/env.js";

app.listen(env.port, env.host, () => {
  console.log(`Backend API running at ${env.backendUrl} on ${env.host}:${env.port}`);
});
