import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blocksForegroundMemoryWrite } from "./foreground-path-guard.ts";

test("foreground path guard blocks canonical files and aliases but allows unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-path-guard-"));
  try {
    const dir = join(root, ".pi/memory");
    await mkdir(dir, { recursive: true });
    for (const name of ["knowledge", "practices", "decisions"])
      await writeFile(join(dir, `${name}.ndjson`), "");
    await symlink(dir, join(root, "alias"));
    await symlink(join(dir, "knowledge.ndjson"), join(root, "file-alias"));
    await symlink(join(root, "missing"), join(root, "dangling"));
    await link(join(dir, "knowledge.ndjson"), join(root, "hardlink"));
    for (const path of [
      ".pi/memory/knowledge.ndjson",
      join(dir, "decisions.ndjson"),
      "@alias/practices.ndjson",
      "file-alias",
      "hardlink",
      "dangling",
    ])
      assert.equal(await blocksForegroundMemoryWrite(root, path), true, path);
    assert.equal(
      await blocksForegroundMemoryWrite(root, "src/new/file.ts"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
