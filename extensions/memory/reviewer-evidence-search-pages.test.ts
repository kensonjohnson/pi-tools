import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryEvidence } from "./reviewer-evidence.ts";

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
