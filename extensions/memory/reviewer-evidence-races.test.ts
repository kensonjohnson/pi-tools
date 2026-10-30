import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryEvidence } from "./reviewer-evidence.ts";

test("excerpt rejects a rewrite between hashing and window capture even when mtime is restored", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-race-"));
  const path = join(root, "source.txt");
  await writeFile(path, "needle original content");
  const before = await stat(path);
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.read;
  await probe.close();
  let changed = false;
  prototype.read = async function (...args: unknown[]) {
    const result = await original.apply(this, args);
    if (!changed) {
      changed = true;
      await writeFile(path, "needle replaced content");
      await utimes(path, before.atime, before.mtime);
    }
    return result;
  };
  try {
    await assert.rejects(
      new RepositoryEvidence(root).excerpt("source.txt", "needle"),
      /changed during read/,
    );
    assert.equal(changed, true);
  } finally {
    prototype.read = original;
    await rm(root, { recursive: true, force: true });
  }
});
