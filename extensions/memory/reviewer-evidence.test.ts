import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryEvidence } from "./reviewer-evidence.ts";

test("file evidence is bounded, scoped, and revalidated against host receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-evidence-"));
  try {
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(project, "fact.txt"), "A real fact\n");
    await writeFile(join(root, "secret.txt"), "secret");
    await symlink(join(root, "secret.txt"), join(project, "link"));
    const evidence = new RepositoryEvidence(project, {
      maxCalls: 10,
      maxFileBytes: 100,
      maxTotalBytes: 100,
    });
    const r = await evidence.read("fact.txt");
    assert.equal((await evidence.verify(r.id, "real fact")).sha256, r.sha256);
    await assert.rejects(evidence.verify("forged", "real"), /unknown/);
    await assert.rejects(evidence.verify(r.id, "invented"), /quote/);
    await assert.rejects(evidence.read("../secret.txt"), /invalid/);
    await assert.rejects(evidence.read(join(root, "secret.txt")), /invalid/);
    await assert.rejects(evidence.read("link"), /symlink/);
    await writeFile(join(project, "fact.txt"), "changed fact\n");
    await assert.rejects(evidence.verify(r.id, "real fact"), /changed/);
    const tiny = new RepositoryEvidence(project, { maxFileBytes: 1 });
    await assert.rejects(tiny.read("fact.txt"), /bounded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
