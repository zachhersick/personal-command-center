import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getVscodeCommand } from "../server.js";

test("uses the installed Windows VS Code executable when code is not on PATH", async () => {
  const localAppData = await mkdtemp(join(tmpdir(), "jarvis-vscode-"));
  const executable = join(localAppData, "Programs", "Microsoft VS Code", "Code.exe");
  try {
    await mkdir(join(localAppData, "Programs", "Microsoft VS Code"), { recursive: true });
    await writeFile(executable, "");
    assert.equal(getVscodeCommand({ workspace: { vscodeCommand: "missing-code" } }, { LOCALAPPDATA: localAppData }, "win32"), executable);
  } finally {
    await rm(localAppData, { recursive: true, force: true });
  }
});
