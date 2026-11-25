import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createDb } from "./db/client";
import { env } from "./env";
import { createApp } from "./app";
import { startScheduler } from "./jobs/scheduler";
import { seedDefaults } from "./db/seed";

const { db } = await createDb();
await seedDefaults(db);
const app = createApp(db);

const webDir = path.resolve("dist/web");
if (env.isProd && fs.existsSync(webDir)) {
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), webDir) }));
  app.get("*", serveStatic({ path: path.relative(process.cwd(), path.join(webDir, "index.html")) }));
}

startScheduler(db);
serve({ fetch: app.fetch, port: env.PORT }, (info) => console.log(`Folio API on http://localhost:${info.port}`));
