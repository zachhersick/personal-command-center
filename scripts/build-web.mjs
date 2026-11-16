// Builds the static part of jarvis.example.com into web-dist/: the same UI
// as the desktop app plus its vendored libraries. No plan data goes here; the
// API serves it only to a signed-in session.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "web-dist");
const VENDOR = ["preact", "htm", "@preact/signals", "@preact/signals-core"];
const SCRIPT = new Set([".js", ".mjs", ".map"]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "public"), out, { recursive: true });

// Copies only the built bundles (any "dist" folder), not tests or sources.
function copyScripts(from, to, inDist = false) {
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    if (name === "node_modules" || name === "src" || name === "test") continue;
    if (statSync(source).isDirectory()) copyScripts(source, join(to, name), inDist || name === "dist");
    else if (inDist && SCRIPT.has(extname(name))) {
      mkdirSync(to, { recursive: true });
      cpSync(source, join(to, name));
    }
  }
}

for (const pkg of VENDOR) {
  const source = join(root, "node_modules", pkg);
  if (!existsSync(source)) throw new Error(`Missing ${pkg}; run npm ci first.`);
  copyScripts(source, join(out, "vendor", pkg));
}
console.log("Built web-dist/");
