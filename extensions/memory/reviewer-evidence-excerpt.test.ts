import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryEvidence } from "./reviewer-evidence.ts";

test("large matching paragraphs yield verified resumable windows with explicit omissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-paragraph-"));
  try {
    const paragraph = `${"a".repeat(700000)}NEEDLE${"é".repeat(150000)}`;
    await writeFile(
      join(root, "source.txt"),
      `first\r\n \t\r\n${paragraph}\n\nlast`,
    );
    const evidence = new RepositoryEvidence(root);
    const excerpt = await evidence.excerpt("source.txt", "needle", {
      maxBytes: 1024,
    });
    assert.ok(excerpt.text.startsWith("NEEDLE"));
    assert.equal(excerpt.excerpt?.omittedBefore, true);
    assert.equal(excerpt.excerpt?.omittedAfter, true);
    assert.ok(excerpt.nextOffset);
    assert.deepEqual(
      (await evidence.verify(excerpt.id, "NEEDLE")).excerpt,
      excerpt.excerpt,
    );
    const next = await evidence.excerpt("source.txt", "needle", {
      offset: excerpt.nextOffset,
      maxBytes: 1024,
    });
    assert.equal(next.excerpt?.windowStart, excerpt.nextOffset);
    assert.equal(next.sha256, excerpt.sha256);
    const first = await evidence.excerpt("source.txt", "needle", {
      offset: excerpt.excerpt!.paragraphStart,
      maxBytes: 1024,
    });
    assert.equal(first.excerpt?.omittedBefore, false);
    assert.equal(first.excerpt?.omittedAfter, true);
    await assert.rejects(
      evidence.excerpt("source.txt", "first\r\n \t\r\na"),
      /no matching paragraph/,
    );
    const small = await evidence.excerpt("source.txt", "first");
    assert.equal(small.text, "first");
    assert.equal(small.excerpt?.omittedBefore, false);
    assert.equal(small.excerpt?.omittedAfter, false);
    await writeFile(
      join(root, "source.txt"),
      `first\r\n \t\r\n${paragraph}changed\n\nlast`,
    );
    await assert.rejects(evidence.verify(excerpt.id, "NEEDLE"), /changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
