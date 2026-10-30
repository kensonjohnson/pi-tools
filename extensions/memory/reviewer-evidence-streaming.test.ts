import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryEvidence } from "./reviewer-evidence.ts";

test("UTF-8 pages preserve boundaries and hash the whole source", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-stream-"));
  try {
    const text = "a😀é終z";
    await writeFile(join(root, "source.txt"), text);
    const evidence = new RepositoryEvidence(root);
    let offset = 0,
      combined = "",
      hash = "";
    do {
      const page = await evidence.read("source.txt", { offset, maxBytes: 4 });
      hash ||= page.sha256;
      assert.equal(page.sha256, hash);
      combined += page.text;
      if (page.nextOffset === undefined) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    } while (true);
    assert.equal(combined, text);
    const page = await evidence.read("source.txt", { maxBytes: 4 });
    await writeFile(join(root, "source.txt"), `${text}changed`);
    await assert.rejects(evidence.verify(page.id, page.text), /changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
