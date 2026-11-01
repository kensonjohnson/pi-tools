import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_CATEGORIES } from "./core.ts";

// Match Pi's built-in write/edit path normalization, then resolve existing
// ancestors. An unresolved symlink or inaccessible path is ambiguous.
async function canonicalTarget(path: string): Promise<string> {
  let current = path;
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(current), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await lstat(current); // A dangling symlink is not safe to classify.
        throw new Error("Unresolved path");
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(
        current.slice(parent.length + (parent.endsWith("/") ? 0 : 1)),
      );
      current = parent;
    }
  }
}

export async function blocksForegroundMemoryWrite(
  cwd: string,
  input: unknown,
): Promise<boolean> {
  if (typeof input !== "string" || !input) return true;
  try {
    let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
    if (path.startsWith("@")) path = path.slice(1);
    if (path === "~") path = homedir();
    else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    else if (path.startsWith("file://")) path = fileURLToPath(path);
    const target = resolve(isAbsolute(path) ? path : join(cwd, path));
    const canonical = await canonicalTarget(target);
    const targetStat = await stat(target).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    for (const category of MEMORY_CATEGORIES) {
      const memory = join(cwd, ".pi", "memory", `${category}.ndjson`);
      if (
        target === resolve(memory) ||
        canonical === (await canonicalTarget(memory))
      )
        return true;
      const memoryStat = await stat(memory).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (
        targetStat &&
        memoryStat &&
        targetStat.dev === memoryStat.dev &&
        targetStat.ino === memoryStat.ino
      )
        return true;
    }
    return false;
  } catch {
    return true;
  }
}
