import { rm } from "node:fs/promises";
import { settleSharedWrites } from "../server/shared-state.js";

// Remove a test's temp folder after a server has used it. On Windows the
// server writes iCloud state in the background, and a directory can't be
// removed while a file is being renamed into it.
export async function removeTempDir(dir) {
  await settleSharedWrites();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
