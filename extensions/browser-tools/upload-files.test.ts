import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageUploadFiles } from "./upload-files.ts";
import { resolveUploadLimits } from "./settings.ts";

test("staging supports more than ten files, snapshots bytes, and cleans up", async () => {
  const root = await mkdtemp(join(tmpdir(), "upload-stage-test-"));
  try {
    const paths = Array.from({ length: 12 }, (_, i) => `${i}.txt`);
    for (const path of paths) await writeFile(join(root, path), path);
    const staged = await stageUploadFiles(
      paths,
      root,
      resolveUploadLimits({}),
      Date.now() + 5000,
    );
    assert.equal(staged.files.length, 12);
    await writeFile(join(root, paths[0]), "changed");
    assert.equal(await readFile(staged.files[0], "utf8"), paths[0]);
    const stagingRoot = join(staged.files[0], "../..");
    await staged.cleanup();
    await assert.rejects(readdir(stagingRoot), { code: "ENOENT" });
    await symlink(join(root, paths[0]), join(root, "link"));
    await assert.rejects(
      stageUploadFiles(
        ["link"],
        root,
        resolveUploadLimits({}),
        Date.now() + 5000,
      ),
      /could not be read/,
    );
    await assert.rejects(
      stageUploadFiles(
        [paths[0]],
        root,
        { maxFileBytes: 1, maxTotalBytes: 1 },
        Date.now() + 5000,
      ),
      /exceeds upload limits/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upload limits accept large values while preserving configured limits", () => {
  assert.deepEqual(resolveUploadLimits({}), {
    maxFileBytes: Number.MAX_SAFE_INTEGER,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(
    resolveUploadLimits({
      uploadMaxFileBytes: 1073741824,
      uploadMaxTotalBytes: 2147483648,
    }),
    { maxFileBytes: 1073741824, maxTotalBytes: 2147483648 },
  );
});
