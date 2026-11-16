import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// electron-builder `files` patterns, enough of the syntax for this repo:
// exact paths, `dir/**`, `dir/**/*.ext`, and `!` exclusions.
function toRegExp(pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${source}$`);
}

function packaged(file) {
  let included = false;
  for (const pattern of pkg.build.files) {
    const exclude = pattern.startsWith("!");
    if (toRegExp(exclude ? pattern.slice(1) : pattern).test(file)) included = !exclude;
  }
  return included;
}

// Follow static relative imports from the app's entry points.
function localImports(file) {
  const text = readFileSync(join(root, file), "utf8");
  const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((match) => match[1]);
  return specifiers.map((specifier) => relative(root, resolve(root, dirname(file), specifier)).replace(/\\/g, "/"));
}

test("every module the desktop app imports is in the packaged files", () => {
  const seen = new Set();
  const queue = [pkg.main, "server.js"];
  const missing = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(existsSync(join(root, file)), `${file} is imported but does not exist`);
    if (!packaged(file)) missing.push(file);
    queue.push(...localImports(file));
  }
  assert.ok(seen.size > 10, "the import walk found the app's modules");
  assert.deepEqual(missing, [], "add these to build.files in package.json");
});

test("the pattern matcher reads electron-builder globs", () => {
  assert.ok(toRegExp("server/**/*.js").test("server/http.js"));
  assert.ok(toRegExp("server/**/*.js").test("server/plan/state.js"));
  assert.ok(toRegExp("server/cloud/**").test("server/cloud/app.js"));
  assert.ok(!toRegExp("desktop/main.mjs").test("desktop/mac.mjs"));
});
