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

test("search match batches continue without dropping later files", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-matches-"));
  try {
    const paths = Array.from({ length: 70 }, (_, i) => `${i}.txt`);
    await Promise.all(
      paths.map((path) => writeFile(join(root, path), "needle")),
    );
    const evidence = new RepositoryEvidence(root);
    let offset = 0,
      count = 0;
    let snapshot: string | undefined;
    do {
      const page = await evidence.search(paths, "needle", { offset, snapshot });
      snapshot = page.snapshot;
      count += page.files.length;
      if (page.nextOffset === undefined) {
        assert.equal(page.incomplete, false);
        break;
      }
      assert.equal(page.incomplete, true);
      offset = page.nextOffset;
    } while (true);
    assert.equal(count, paths.length);
    const first = await evidence.search(paths, "needle", { limit: 2 });
    const options = { offset: first.nextOffset!, snapshot: first.snapshot };
    for (const [changedPaths, changedQuery] of [
      [paths.slice(1), "needle"],
      [[paths[1], paths[0], ...paths.slice(2)], "needle"],
      [paths, "different"],
    ] as Array<[string[], string]>) {
      const result = await evidence.search(changedPaths, changedQuery, options);
      assert.equal(result.changed, true);
      assert.equal(result.incomplete, true);
      assert.equal(result.examined, 0);
      assert.deepEqual(result.files, []);
    }
    const missing = await evidence.search(paths, "needle", { offset: 2 });
    assert.equal(missing.changed, true);
    assert.equal(missing.incomplete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
