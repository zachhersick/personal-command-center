// Vercel serverless entry for jarvis.example.com. Every /api/* request is
// rewritten here (see vercel.json). Not used by the desktop app.
import { createCloudApp } from "../server/cloud/app.js";
import { MemoryStore, NeonStore } from "../server/cloud/store.js";

const store = process.env.DATABASE_URL ? new NeonStore(process.env.DATABASE_URL) : new MemoryStore();
// The deployed app never offers the local sign-in shortcut, whatever its
// environment says.
const app = createCloudApp({ store, env: { ...process.env, JARVIS_CLOUD_DEV_LOGIN: "" } });

export default function handler(req, res) {
  return app.handle(req, res);
}
