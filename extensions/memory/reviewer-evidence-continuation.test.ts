import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryEvidence } from "./reviewer-evidence.ts";

test("evidence discovery and search retain later matches and paginate explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-pages-"));
  try {
    for (let i = 0; i < 1105; i++)
      await writeFile(
        join(root, `file-${String(i).padStart(4, "0")}.txt`),
        i >= 1099 ? "needle" : "other",
      );
    await writeFile(join(root, ".secret"), "needle");
    await symlink(join(root, "file-1104.txt"), join(root, "link.txt"));
    const evidence = new RepositoryEvidence(root);
    const all = await evidence.discover();
    assert.equal(all.paths.length, 1105);
    assert.equal(all.truncated, false);
    const first = await evidence.discover({ limit: 100 });
    assert.equal(first.nextOffset, 100);
    const rest = await evidence.discover({
      offset: first.nextOffset,
      snapshot: first.snapshot,
    });
    assert.deepEqual([...first.paths, ...rest.paths], all.paths);
    assert.equal(
      (await evidence.discover({ offset: first.nextOffset })).changed,
      true,
    );
    await rm(join(root, first.paths[0]));
    const changed = await evidence.discover({
      offset: first.nextOffset,
      snapshot: first.snapshot,
    });
    assert.equal(changed.changed, true);
    assert.equal(changed.truncated, true);
    assert.deepEqual(changed.paths, []);
    await writeFile(join(root, first.paths[0]), "other");
    let offset = 0;
    let matches = 0;
    let snapshot: string | undefined;
    do {
      const page = await evidence.search(all.paths, "needle", {
        offset,
        limit: 100,
        snapshot,
      });
      snapshot = page.snapshot;
      matches += page.files.length;
      if (page.nextOffset === undefined) {
        assert.equal(page.incomplete, false);
        break;
      }
      assert.equal(page.incomplete, true);
      offset = page.nextOffset;
    } while (true);
    assert.equal(matches, 6);
    await assert.rejects(evidence.read("link.txt"), /symlink/);
    await assert.rejects(evidence.read(".secret"), /private/);
    await assert.rejects(evidence.read("../outside"), /invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default evidence accepts large files, many calls, and long queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-large-"));
  try {
    const query = "x".repeat(300);
    await writeFile(
      join(root, "large.txt"),
      `${"a".repeat(1100000)}\n\n${query}`,
    );
    const evidence = new RepositoryEvidence(root);
    for (let i = 0; i < 17; i++) {
      const first = await evidence.read("large.txt");
      assert.equal(first.text.length, 256 * 1024);
      assert.equal(first.nextOffset, 256 * 1024);
      await evidence.verify(first.id, first.text.slice(0, 5));
      const second = await evidence.read("large.txt", {
        offset: first.nextOffset,
        maxBytes: 900000,
      });
      assert.equal(second.nextOffset, undefined);
    }
    const excerpt = await evidence.excerpt("large.txt", query);
    assert.equal(excerpt.text, query);
    await evidence.verify(excerpt.id, query);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
