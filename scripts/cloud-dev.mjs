// Runs the cloud Jarvis locally (what jarvis.example.com serves), with an
// in-memory database and a "Sign in" that skips GitHub. For development only.
//   npm run build:web && npm run cloud:dev   ->  http://localhost:4320
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCloudApp } from "../server/cloud/app.js";
import { MemoryStore, NeonStore } from "../server/cloud/store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4320);
const web = join(root, "web-dist");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".map": "application/json", ".woff2": "font/woff2" };

const env = {
  APP_URL: `http://localhost:${port}`,
  SESSION_SECRET: "local-development-secret-not-for-production",
  ALLOWED_GITHUB_ID: "1",
  JARVIS_CLOUD_DEV_LOGIN: "1",
  ...process.env
};
delete env.VERCEL;
const store = env.DATABASE_URL ? new NeonStore(env.DATABASE_URL) : new MemoryStore();
const app = createCloudApp({ store, env, resourceRoot: root });
if (app.config.missing.length) console.warn("Missing config:", app.config.missing.join(", "));
if (env.DATABASE_URL) console.warn("A real database is connected, so the sign-in shortcut is off. Sign in with GitHub.");

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) return app.handle(req, res);
  const path = normalize(join(web, url.pathname === "/" ? "index.html" : url.pathname));
  if (!path.startsWith(web) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control": "no-cache" });
  return res.end(readFileSync(path));
// This computer only: the sign-in shortcut would let anyone on the same
// network in.
}).listen(port, "127.0.0.1", () => console.log(`Jarvis cloud (local) on http://localhost:${port} using ${env.DATABASE_URL ? "Postgres" : "memory"}`));
