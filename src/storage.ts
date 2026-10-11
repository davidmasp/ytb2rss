import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isFreshCache } from "./convert.ts";
import type { CachedChannel } from "./convert.ts";

export async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readCache(path: string): Promise<Map<string, CachedChannel>> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  try {
    const data = JSON.parse(text);
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error("Unsupported cache format.");
    const result = new Map<string, CachedChannel>();
    for (const entry of data.entries) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
          && entry[1] && typeof entry[1] === "object" && isFreshCache(entry[1])) result.set(entry[0], entry[1]);
    }
    return result;
  } catch {
    throw new Error(`Cannot read cache ${path}; use --no-cache or choose another --cache file.`);
  }
}

export async function writeCache(path: string, cache: Map<string, CachedChannel>): Promise<void> {
  await atomicWrite(path, `${JSON.stringify({ version: 1, entries: [...cache] }, null, 2)}\n`);
}
