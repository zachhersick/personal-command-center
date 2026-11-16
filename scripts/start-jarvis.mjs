import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const command = process.platform === "win32"
  ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "start-jarvis.ps1")]]
  : ["sh", [join(root, "scripts", "start-jarvis-mac.sh")]];

const result = spawnSync(command[0], command[1], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
