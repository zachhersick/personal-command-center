// Git worktrees: every Jarvis-launched run gets its own checkout on its own
// branch, so agents never touch the main working tree or each other.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKTREE_DIR = ".agent-worktrees";
const MAX_PATCH_BYTES = 400_000;

export async function git(cwd, args, { timeout = 30_000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout, maxBuffer, windowsHide: true });
  return stdout.replace(/\s+$/, "");
}

export function slugify(text, max = 40) {
  return String(text || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "task";
}

export async function repoRoot(path) {
  return git(path, ["rev-parse", "--show-toplevel"]);
}

async function ensureExcluded(root) {
  const commonDir = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const exclude = join(commonDir, "info", "exclude");
  const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  if (!current.split(/\r?\n/).includes(`${WORKTREE_DIR}/`)) {
    await mkdir(dirname(exclude), { recursive: true });
    await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${WORKTREE_DIR}/\n`);
  }
}

export async function createWorktree({ repo, name, base = "HEAD" }) {
  const root = await repoRoot(repo);
  await ensureExcluded(root);
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
  const slug = `${slugify(name, 32)}-${stamp}-${randomUUID().slice(0, 8)}`;
  const path = resolve(root, WORKTREE_DIR, slug);
  const branch = `agent/${slug}`;
  // --end-of-options keeps a base like "--output=x" from being read as a flag.
  const baseSha = await git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  await git(root, ["worktree", "add", "-b", branch, path, baseSha], { timeout: 120_000 });
  return { root, path, branch, baseSha };
}

// Diff of everything the agent changed relative to the base commit, including
// uncommitted and brand-new files.
export async function worktreeDiff({ path, baseSha }) {
  if (!existsSync(path)) return { files: [], patch: "", truncated: false, missing: true };
  await git(path, ["add", "-A", "-N"]).catch(() => {});
  const [numstat, patch] = await Promise.all([
    git(path, ["diff", "--numstat", baseSha]),
    git(path, ["diff", "--no-color", baseSha])
  ]);
  const files = numstat.split(/\r?\n/).filter(Boolean).map((line) => {
    const [added, removed, ...rest] = line.split("\t");
    return { path: rest.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0, binary: added === "-" };
  });
  const truncated = patch.length > MAX_PATCH_BYTES;
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    patch: truncated ? patch.slice(0, MAX_PATCH_BYTES) : patch,
    truncated
  };
}

export async function removeWorktree({ root, path, branch, deleteBranch = true }) {
  if (existsSync(path)) await git(root, ["worktree", "remove", "--force", path], { timeout: 120_000 });
  else await git(root, ["worktree", "prune"]).catch(() => {});
  if (deleteBranch && branch) await git(root, ["branch", "-D", branch]).catch(() => {});
}

// Commit whatever the agent left uncommitted so the branch can be kept or
// turned into a PR. Never pushes.
export async function commitAll({ path, message }) {
  await git(path, ["add", "-A"]);
  const status = await git(path, ["status", "--porcelain"]);
  if (!status) return { committed: false };
  await git(path, ["-c", "user.useConfigOnly=true", "commit", "-m", message]);
  return { committed: true, sha: await git(path, ["rev-parse", "HEAD"]) };
}
