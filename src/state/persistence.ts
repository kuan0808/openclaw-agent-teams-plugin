/**
 * Unified JSON file I/O with atomic writes.
 *
 * Uses write-to-temp + rename pattern to avoid partial/corrupt writes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Read and parse a JSON file, returning `fallback` if the file does not exist
 * or contains invalid JSON.
 */
export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    // Corrupt / unparseable — treat as missing
    if (err instanceof SyntaxError) {
      return fallback;
    }
    throw err;
  }
}

/**
 * Atomically write JSON to disk.
 *
 * Writes to a temporary file in the same directory, then renames.
 * This guarantees readers never see a partially-written file.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  const json = JSON.stringify(data, null, 2) + "\n";

  await fs.writeFile(tmpPath, json, "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Recursively create a directory (equivalent to `mkdir -p`).
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
