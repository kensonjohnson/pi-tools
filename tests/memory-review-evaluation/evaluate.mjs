#!/usr/bin/env node
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { sanitizeDiagnostics } from "./diagnostics.mjs";

const categories = ["knowledge", "practices", "decisions"];
// These are deliberately narrow: historical picker-gate observations are not stale claims.
const checks = {
  brave_crash:
    /browser_start in extensions\/browser-tools\/index\.ts spawns a hard-coded macOS Brave path without an error listener/i,
  brave_backend:
    /Browser Tools uses puppeteer-core with per-call CDP connections/i,
  picker_single_unframed:
    /preliminary picker supports one selection on visible unframed owned pages/i,
};

async function corpus(root) {
  const records = [];
  for (const category of categories) {
    const text = await readFile(
      join(root, ".pi", "memory", `${category}.ndjson`),
      "utf8",
    );
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`Malformed ${category} line ${index + 1}`);
      }
      if (typeof entry.id !== "string" || typeof entry.content !== "string")
        throw new Error(`Invalid ${category} line ${index + 1}`);
      records.push({ ...entry, category });
    }
  }
  if (new Set(records.map((x) => x.id)).size !== records.length)
    throw new Error("Duplicate memory IDs");
  return records;
}

export function compare(before, after) {
  const old = new Map(before.map((x) => [x.id, x]));
  const current = new Map(after.map((x) => [x.id, x]));
  const exactContents = new Set(after.map((x) => x.content));
  const instructions = before.filter((x) => x.category !== "knowledge");
  const result = {
    counts: {
      before: before.length,
      after: after.length,
      added: 0,
      removed: 0,
      changed: 0,
      moved: 0,
      distinctChanged: 0,
    },
    stale: {},
    instructionCandidates: {
      total: instructions.length,
      exactPreserved: 0,
      exactPreservedInOriginalCategory: 0,
      reviewRequired: 0,
    },
  };
  for (const x of before) {
    const now = current.get(x.id);
    if (!now) {
      result.counts.removed++;
      result.counts.distinctChanged++;
    } else {
      if (now.content !== x.content) result.counts.changed++;
      if (now.category !== x.category) result.counts.moved++;
      if (now.content !== x.content || now.category !== x.category)
        result.counts.distinctChanged++;
    }
  }
  for (const x of after)
    if (!old.has(x.id)) {
      result.counts.added++;
      result.counts.distinctChanged++;
    }
  for (const [name, match] of Object.entries(checks)) {
    const matched = before.filter((x) => match.test(x.content));
    const b = matched.length;
    const a = after.filter((x) => match.test(x.content)).length;
    result.stale[name] = {
      before: b,
      after: a,
      originalIdsRemoved: matched.filter((x) => !current.has(x.id)).length,
      originalIdsChanged: matched.filter((x) => {
        const now = current.get(x.id);
        return now && now.content !== x.content;
      }).length,
      status: a
        ? "still_present"
        : b === 0
          ? "fixture_absent"
          : "removed_or_reworded_review",
    };
  }
  for (const x of instructions) {
    if (exactContents.has(x.content))
      result.instructionCandidates.exactPreserved++;
    else result.instructionCandidates.reviewRequired++;
    if (after.some((y) => y.category === x.category && y.content === x.content))
      result.instructionCandidates.exactPreservedInOriginalCategory++;
  }
  return result;
}

const coverageFields = [
  "evidenceGaps",
  "limitedPages",
  "discoveryTruncatedPages",
  "searchIncompletePages",
  "candidatesTruncatedPages",
  "memoryEvaluations",
  "snapshotMemories",
];
const gapReasons = [
  "model_insufficient",
  "missing_reason",
  "no_evidence",
  "evidence_failures",
  "requests_truncated",
  "search_incomplete",
  "fragment_insufficient",
];
const natural = (x) => Number.isSafeInteger(x) && x >= 0;
function sanitizeReport(report) {
  if (
    !report ||
    !["done", "pending", "unresolved", "uncertain", "error"].includes(
      report.status,
    ) ||
    !natural(report.calls) ||
    !natural(report.pages) ||
    !(report.changes === null || natural(report.changes))
  )
    throw new Error("Invalid reviewer outcome");
  let coverage = null;
  if (
    report.coverage &&
    typeof report.coverage === "object" &&
    !Array.isArray(report.coverage)
  ) {
    coverage = {};
    for (const key of coverageFields)
      if (natural(report.coverage[key])) coverage[key] = report.coverage[key];
    coverage.gapReasons = {};
    if (
      report.coverage.gapReasons &&
      typeof report.coverage.gapReasons === "object"
    )
      for (const key of gapReasons)
        if (natural(report.coverage.gapReasons[key]))
          coverage.gapReasons[key] = report.coverage.gapReasons[key];
  }
  const errorCodes = [
    "setup_failed",
    "model_unavailable",
    "auth_unavailable",
    "model_not_text",
    "model_not_configured",
    "config_invalid",
    "review_failed",
  ];
  const diagnostics = sanitizeDiagnostics(report.diagnostics);
  return {
    status: report.status,
    calls: report.calls,
    pages: report.pages,
    changes: report.changes,
    coverage,
    ...(diagnostics ? { diagnostics } : {}),
    ...(report.reason === "limit" ? { reason: "limit" } : {}),
    ...(report.status === "error" && errorCodes.includes(report.errorCode)
      ? { errorCode: report.errorCode }
      : {}),
  };
}

export function assess(result) {
  const flags = [];
  if (!result.reviewer) flags.push("reviewer_not_run_or_unreported");
  else if (result.reviewer.status !== "done")
    flags.push(`reviewer_${result.reviewer.status}`);
  if (result.adapterFailed) flags.push("adapter_failed");
  const coverage = result.reviewer?.coverage;
  if (
    !coverage ||
    ![
      "evidenceGaps",
      "limitedPages",
      "discoveryTruncatedPages",
      "searchIncompletePages",
      "candidatesTruncatedPages",
    ].every((key) => natural(coverage[key]))
  )
    flags.push("coverage_missing");
  else if (
    [
      "evidenceGaps",
      "limitedPages",
      "discoveryTruncatedPages",
      "searchIncompletePages",
      "candidatesTruncatedPages",
    ].some((key) => coverage[key] > 0) ||
    Object.values(coverage.gapReasons ?? {}).some((x) => x > 0)
  )
    flags.push("coverage_gaps_or_limits");
  if (Object.values(result.stale).some((x) => x.status === "fixture_absent"))
    flags.push("stale_fixture_absent");
  if (
    Object.values(result.stale).some(
      (x) => x.status === "removed_or_reworded_review",
    )
  )
    flags.push("stale_correction_needs_review");
  if (
    result.reviewer?.status === "done" &&
    natural(coverage?.snapshotMemories) &&
    coverage.snapshotMemories > 0 &&
    coverage.memoryEvaluations === 0
  )
    flags.push("no_memory_evaluations");
  if (result.instructionCandidates.reviewRequired)
    flags.push("instructions_need_review");
  const stale = Object.values(result.stale).some(
    (x) => x.status === "still_present",
  );
  if (stale) flags.push("known_stale_present");
  return {
    evaluation: stale ? "fail" : flags.length ? "incomplete" : "pass",
    flags,
  };
}

async function copySource(source, dest) {
  // No symlinks, private state, dependencies, or runtime outputs enter the fixture.
  for (const name of [
    "extensions",
    "lib",
    "skills",
    "tests",
    "README.md",
    "package.json",
    "package-lock.json",
    ".github",
  ]) {
    const from = join(source, name);
    try {
      await lstat(from);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    await cp(from, join(dest, name), {
      recursive: true,
      filter: async (path) => !(await lstat(path)).isSymbolicLink(),
    });
  }
  await mkdir(join(dest, ".pi", "memory"), { recursive: true, mode: 0o700 });
  for (const category of categories) {
    const file = join(source, ".pi", "memory", `${category}.ndjson`);
    if (!(await lstat(file)).isFile())
      throw new Error(`Expected regular ${category} memory file`);
    await cp(file, join(dest, ".pi", "memory", `${category}.ndjson`));
  }
}

async function command(argv, root, verbose, nonce, forwardEnv, retain) {
  const home = join(root, ".evaluation-home");
  await mkdir(home, { mode: 0o700 });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: root,
      shell: false,
      env: {
        ...Object.fromEntries(
          forwardEnv
            .map((name) => [name, process.env[name]])
            .filter(([, value]) => value !== undefined),
        ),
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: home,
        TMPDIR: home,
        LANG: "C.UTF-8",
        MEMORY_EVALUATION_PROJECT: root,
        MEMORY_EVALUATION_NONCE: nonce,
        MEMORY_EVALUATION_RETAINED: retain ? "1" : "0",
      },
      stdio: [
        "ignore",
        verbose ? "inherit" : "ignore",
        verbose ? "inherit" : "ignore",
      ],
    });
    child.on("error", () => reject(new Error("Adapter failed to start")));
    child.on("close", (code, signal) =>
      code === 0
        ? resolvePromise()
        : reject(
            new Error(
              `Adapter failed (exit ${code ?? "none"}, signal ${signal ?? "none"}); output suppressed unless --show-raw`,
            ),
          ),
    );
  });
}

async function sourceHashes(source) {
  return Promise.all(
    categories.map(async (category) =>
      createHash("sha256")
        .update(
          await readFile(join(source, ".pi", "memory", `${category}.ndjson`)),
        )
        .digest("hex"),
    ),
  );
}

export async function run({
  source,
  argv = [],
  showRaw = false,
  forwardEnv = [],
  retain = false,
}) {
  const hashes = await sourceHashes(source);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "memory-evaluation-")),
  );
  try {
    await copySource(source, root);
    if (retain) {
      const baseline = join(root, ".pi", "memory", ".evaluation-before");
      await mkdir(baseline, { mode: 0o700 });
      for (const category of categories)
        await cp(
          join(root, ".pi", "memory", `${category}.ndjson`),
          join(baseline, `${category}.ndjson`),
        );
    }
    const nonce = randomBytes(32).toString("hex");
    await writeFile(join(root, ".memory-evaluation-marker"), nonce, {
      mode: 0o600,
      flag: "wx",
    });
    const before = await corpus(root);
    let adapterFailed = false;
    if (argv.length) {
      try {
        await command(argv, root, showRaw, nonce, forwardEnv, retain);
      } catch {
        adapterFailed = true;
      }
    }
    const after = await corpus(root);
    const result = compare(before, after);
    if (retain) result.retainedProject = root;
    if (adapterFailed) result.adapterFailed = true;
    try {
      result.reviewer = sanitizeReport(
        JSON.parse(
          await readFile(join(root, ".memory-evaluation-outcome.json"), "utf8"),
        ),
      );
    } catch (e) {
      if (e.code !== "ENOENT") result.adapterFailed = true;
    }
    result.progress = {
      netChangedIds: result.counts.distinctChanged,
      memoryEvaluations: result.reviewer?.coverage?.memoryEvaluations ?? null,
      lastSnapshotMemories: result.reviewer?.coverage?.snapshotMemories ?? null,
    };
    Object.assign(result, assess(result));
    if (showRaw) {
      result.rawBefore = before;
      result.rawAfter = after;
      const afterContents = new Set(after.map((x) => x.content));
      result.instructionCandidates.unmatched = before
        .filter(
          (x) => x.category !== "knowledge" && !afterContents.has(x.content),
        )
        .map((x) => ({ category: x.category, id: x.id, content: x.content }));
    }
    return result;
  } catch (error) {
    if (retain && error instanceof Error) error.retainedProject = root;
    throw error;
  } finally {
    if (!retain) await rm(root, { recursive: true, force: true });
    if (JSON.stringify(hashes) !== JSON.stringify(await sourceHashes(source))) {
      const error = new Error(
        "Source memory files changed during evaluation; inspect concurrent writes",
      );
      if (retain) error.retainedProject = root;
      throw error;
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const argv = separator < 0 ? [] : args.slice(separator + 1);
  const envOptions = options.filter((x) => x.startsWith("--env="));
  const forwardEnv = envOptions.map((x) => x.slice(6));
  if (
    options.some(
      (x) =>
        x !== "--show-raw" &&
        x !== "--retain" &&
        x !== "--strict" &&
        !x.startsWith("--env="),
    ) ||
    forwardEnv.some(
      (x) =>
        !/^[A-Z][A-Z0-9_]*$/.test(x) ||
        [
          "HOME",
          "TMPDIR",
          "PATH",
          "MEMORY_EVALUATION_PROJECT",
          "MEMORY_EVALUATION_NONCE",
          "MEMORY_EVALUATION_RETAINED",
          "NODE_OPTIONS",
        ].includes(x),
    ) ||
    (separator >= 0 && !argv.length)
  ) {
    console.error(
      "Usage: node tests/memory-review-evaluation/evaluate.mjs [--strict] [--retain] [--show-raw] [--env=NAME ...] [-- adapter arg ...]",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await run({
        source: process.cwd(),
        argv,
        forwardEnv,
        retain: options.includes("--retain"),
        showRaw: options.includes("--show-raw"),
      });
      console.log(JSON.stringify(result, null, 2));
      if (options.includes("--strict") && result.evaluation !== "pass")
        process.exitCode = 2;
    } catch (e) {
      console.error(
        `Evaluation failed: ${e.message}${e.retainedProject ? `; retainedProject: ${e.retainedProject}` : ""}`,
      );
      process.exitCode = 1;
    }
  }
}
