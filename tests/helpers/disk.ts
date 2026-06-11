import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Recursively sum the size of all files under a directory. */
export async function totalDiskSize(dir: string): Promise<number> {
  let sum = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      sum += await totalDiskSize(fullPath);
    } else if (entry.isFile()) {
      sum += (await stat(fullPath)).size;
    }
  }
  return sum;
}
