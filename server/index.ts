import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createCatch } from "./app.ts";

const config = loadConfig();
const catchApp = createCatch(config);
catchApp.startBackground();

const server = serve({ fetch: catchApp.app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Catch listening on http://${config.host}:${info.port}  (public URL ${config.publicUrl})`);
  console.log(`  transcriber: ${catchApp.ctx.transcriber.name}   extractor: ${catchApp.ctx.extractor.name}`);
  if (catchApp.ctx.extractor.name === "mock") {
    console.log("  OFFLINE MODE: set ANTHROPIC_API_KEY (and OPENAI_API_KEY for voice) to read screenshots and voice notes.");
  }
});

async function shutdown(signal: string) {
  console.log(`${signal}: finishing running jobs, then exiting`);
  server.close();
  await catchApp.stop();
  catchApp.ctx.db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
