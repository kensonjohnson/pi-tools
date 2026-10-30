import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { run, compare, assess } from "./evaluate.mjs";

const entry = (id, content, category = "knowledge") => ({
  id,
  content,
  category,
});
test("counts stale claims and flags changed instructions for human review", () => {
  const stale =
    "Browser Tools uses puppeteer-core with per-call CDP connections";
  const before = [
    entry("a", stale),
    entry("b", "Never reveal SECRET", "decisions"),
  ];
  const result = compare(before, [
    entry("b", "Never disclose SECRET", "decisions"),
  ]);
  assert.equal(result.stale.brave_backend.status, "removed_or_reworded_review");
  assert.equal(result.stale.brave_crash.status, "fixture_absent");
  assert.equal(result.instructionCandidates.reviewRequired, 1);
  assert.equal(result.counts.removed, 1);
  assert.equal(result.counts.changed, 1);
});

test("quality assessment flags gaps and incomplete reviews instead of claiming success", () => {
  const stale = { x: { status: "removed_or_reworded_review" } };
  const base = {
    stale,
    instructionCandidates: { reviewRequired: 0 },
    reviewer: {
      status: "done",
      coverage: {
        evidenceGaps: 0,
        limitedPages: 0,
        discoveryTruncatedPages: 0,
        searchIncompletePages: 0,
        candidatesTruncatedPages: 1,
        gapReasons: {},
      },
    },
  };
  assert.equal(assess(base).evaluation, "incomplete");
  assert.ok(assess(base).flags.includes("coverage_gaps_or_limits"));
  assert.ok(assess(base).flags.includes("stale_correction_needs_review"));
  assert.equal(
    assess({ ...base, stale: { x: { status: "still_present" } } }).evaluation,
    "fail",
  );
  assert.ok(
    assess({
      ...base,
      reviewer: { status: "unresolved", coverage: null },
    }).flags.includes("coverage_missing"),
  );
  assert.ok(
    assess({
      ...base,
      reviewer: { status: "error", coverage: null },
    }).flags.includes("reviewer_error"),
  );
});

test("strict mode exits nonzero for a known-stale offline baseline", async () => {
  const source = await mkdtemp(join(tmpdir(), "memory-eval-source-"));
  try {
    const dir = join(source, ".pi", "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "knowledge.ndjson"),
      JSON.stringify({
        id: "a",
        content:
          "Browser Tools uses puppeteer-core with per-call CDP connections",
      }) + "\n",
    );
    await writeFile(join(dir, "practices.ndjson"), "");
    await writeFile(join(dir, "decisions.ndjson"), "");
    const result = spawnSync(
      process.execPath,
      [new URL("./evaluate.mjs", import.meta.url).pathname, "--strict"],
      { cwd: source, encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).evaluation, "fail");
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

test("adapter changes only disposable copy, and cleanup happens on success and failure", async () => {
  const source = await mkdtemp(join(tmpdir(), "memory-eval-source-"));
  try {
    const dir = join(source, ".pi", "memory");
    await mkdir(dir, { recursive: true });
    const original =
      JSON.stringify({ id: "a", content: "Never reveal SECRET" }) + "\n";
    await writeFile(join(dir, "decisions.ndjson"), original);
    await writeFile(join(dir, "knowledge.ndjson"), "");
    await writeFile(join(dir, "practices.ndjson"), "");
    const script =
      "require('fs').writeFileSync('.pi/memory/decisions.ndjson','')";
    const result = await run({
      source,
      argv: [process.execPath, "-e", script],
    });
    assert.equal(result.instructionCandidates.reviewRequired, 1);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    assert.equal(
      await readFile(join(dir, "decisions.ndjson"), "utf8"),
      original,
    );
    const snapshot = (await readdir(tmpdir()))
      .filter((x) => x.startsWith("memory-evaluation-"))
      .sort();
    const failed = await run({
      source,
      argv: [process.execPath, "-e", `${script}; process.exit(4)`],
    });
    assert.equal(failed.adapterFailed, true);
    assert.equal(failed.counts.distinctChanged, 1);
    assert.equal(failed.evaluation, "incomplete");
    const reportScript = `${script}; require('fs').writeFileSync('.memory-evaluation-outcome.json', JSON.stringify({status:'error',calls:2,pages:0,changes:null,coverage:null}))`;
    const partial = await run({
      source,
      argv: [process.execPath, "-e", reportScript],
    });
    assert.equal(partial.reviewer.status, "error");
    assert.equal(partial.reviewer.changes, null);
    assert.equal(partial.counts.distinctChanged, 1);
    assert.equal(partial.evaluation, "incomplete");
    assert.deepEqual(
      (await readdir(tmpdir()))
        .filter((x) => x.startsWith("memory-evaluation-"))
        .sort(),
      snapshot,
    );
    assert.equal(
      await readFile(join(dir, "decisions.ndjson"), "utf8"),
      original,
    );
    const retained = await run({
      source,
      retain: true,
      argv: [process.execPath, "-e", script],
    });
    try {
      assert.equal((await stat(retained.retainedProject)).mode & 0o777, 0o700);
      assert.ok(!JSON.stringify(retained).includes("SECRET"));
      assert.equal(
        await readFile(
          join(
            retained.retainedProject,
            ".pi/memory/.evaluation-before/decisions.ndjson",
          ),
          "utf8",
        ),
        original,
      );
      assert.equal(
        await readFile(
          join(retained.retainedProject, ".pi/memory/decisions.ndjson"),
          "utf8",
        ),
        "",
      );
    } finally {
      await rm(retained.retainedProject, { recursive: true, force: true });
    }
    const retainedFailure = await run({
      source,
      retain: true,
      argv: [process.execPath, "-e", "process.exit(4)"],
    });
    assert.equal(retainedFailure.adapterFailed, true);
    assert.ok(retainedFailure.retainedProject);
    await rm(retainedFailure.retainedProject, { recursive: true, force: true });
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
