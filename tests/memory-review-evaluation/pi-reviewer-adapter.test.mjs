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
import { randomUUID } from "node:crypto";
import { run } from "./evaluate.mjs";
import { execute, runtimeOptions } from "./pi-reviewer-adapter.mjs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const adapter = new URL("./pi-reviewer-adapter.mjs", import.meta.url).href;
const driver = `import { execute } from ${JSON.stringify(adapter)};
const model = {generate: async ({instruction}) => instruction.startsWith('Select') ? {paths:[]} : {action:'no_change',reason:'Reviewed HIDDEN_SENTINEL',evidenceSufficient:true}};
await execute({project:process.env.MEMORY_EVALUATION_PROJECT,nonce:process.env.MEMORY_EVALUATION_NONCE,model,privateTrace:process.env.MEMORY_REVIEW_PRIVATE_TRACE==='1',maxCalls:Number(process.argv[1]),maxPasses:100,timeoutMs:30000});`;

test("rejects an unmarked checkout before initializing a store", async () => {
  await assert.rejects(
    execute({ project: process.cwd(), nonce: "a".repeat(64), model: {} }),
    /isolated|ENOENT/,
  );
});

test("runtime configuration opts into absolute auth and model config paths", () => {
  const signal = new AbortController().signal;
  const defaults = runtimeOptions("/tmp/private-runtime", signal);
  assert.equal(defaults.authPath, "/tmp/private-runtime/auth.json");
  assert.equal(defaults.modelsPath, null);
  const explicit = runtimeOptions(
    "/tmp/private-runtime",
    signal,
    "/tmp/auth.json",
    "/tmp/custom-models.json",
  );
  assert.equal(explicit.authPath, "/tmp/auth.json");
  assert.equal(explicit.modelsPath, "/tmp/custom-models.json");
  assert.equal(explicit.allowModelNetwork, false);
  const cached = runtimeOptions(
    "/tmp/private-runtime",
    signal,
    undefined,
    undefined,
    "/tmp/private-runtime/catalog.json",
  );
  assert.equal(cached.modelsPath, "/tmp/private-runtime/empty-models.json");
  assert.equal(cached.modelsStorePath, "/tmp/private-runtime/catalog.json");
  assert.throws(
    () => runtimeOptions("/tmp/private-runtime", signal, "relative-auth"),
    /absolute/,
  );
  assert.throws(
    () =>
      runtimeOptions(
        "/tmp/private-runtime",
        signal,
        undefined,
        "relative-models",
      ),
    /absolute/,
  );
  assert.throws(
    () =>
      runtimeOptions(
        "/tmp/private-runtime",
        signal,
        undefined,
        undefined,
        "relative-store",
      ),
    /absolute/,
  );
});

test("real reviewer traverses disposable pages with fake model and reports bounded incomplete runs", async () => {
  const source = await mkdtemp(join(tmpdir(), "memory-eval-source-"));
  try {
    const dir = join(source, ".pi", "memory");
    await mkdir(dir, { recursive: true });
    const original =
      Array.from({ length: 90 }, (_, i) =>
        JSON.stringify({
          id: randomUUID(),
          created: new Date().toISOString(),
          content: `Fact ${i}: ${"evidence ".repeat(80)}`,
        }),
      ).join("\n") + "\n";
    await writeFile(join(dir, "knowledge.ndjson"), original);
    await writeFile(join(dir, "practices.ndjson"), "");
    await writeFile(join(dir, "decisions.ndjson"), "");
    const limited = await run({
      source,
      argv: [process.execPath, "--input-type=module", "-e", driver, "1"],
    });
    assert.equal(limited.reviewer.status, "pending");
    assert.equal(limited.reviewer.reason, "limit");
    assert.equal(limited.reviewer.calls, 1);
    const full = await run({
      source,
      argv: [process.execPath, "--input-type=module", "-e", driver, "300"],
    });
    assert.equal(full.reviewer.status, "unresolved");
    assert.equal(full.evaluation, "incomplete");
    assert.ok(full.flags.includes("reviewer_unresolved"));
    assert.ok(
      full.reviewer.coverage &&
        Number.isSafeInteger(full.reviewer.coverage.evidenceGaps),
    );
    assert.ok(
      full.reviewer.diagnostics.entries.some(
        (x) =>
          x.stage === "evidence_selection" && x.evidenceRequests.paths === 0,
      ),
    );
    assert.ok(
      full.reviewer.diagnostics.entries.some(
        (x) =>
          x.stage === "decision" &&
          x.actionCounts.no_change === 1 &&
          x.evidenceSufficient.true === 1 &&
          x.proposals[0].citationKind === "other",
      ),
    );
    assert.ok(full.reviewer.diagnostics.reviewOutcomes.length > 0);
    assert.equal(full.reviewer.diagnostics.finalOutcome.status, "unresolved");
    assert.ok(!JSON.stringify(full).includes("HIDDEN_SENTINEL"));
    assert.ok(full.reviewer.pages > 1);
    assert.equal(full.counts.before, 90);
    assert.equal(
      await readFile(join(dir, "knowledge.ndjson"), "utf8"),
      original,
    );
    const untraced = await run({
      source,
      retain: true,
      argv: [process.execPath, "--input-type=module", "-e", driver, "1"],
    });
    try {
      await assert.rejects(
        stat(join(untraced.retainedProject, ".evaluation-runtime")),
        { code: "ENOENT" },
      );
    } finally {
      await rm(untraced.retainedProject, { recursive: true, force: true });
    }
    const priorTrace = process.env.MEMORY_REVIEW_PRIVATE_TRACE;
    try {
      process.env.MEMORY_REVIEW_PRIVATE_TRACE = "1";
      const traced = await run({
        source,
        retain: true,
        forwardEnv: ["MEMORY_REVIEW_PRIVATE_TRACE"],
        argv: [process.execPath, "--input-type=module", "-e", driver, "300"],
      });
      try {
        const traceDir = join(traced.retainedProject, ".evaluation-runtime");
        assert.equal((await stat(traceDir)).mode & 0o777, 0o700);
        const files = (await readdir(traceDir)).filter((x) =>
          x.startsWith("private-trace-"),
        );
        assert.ok(files.length > 0);
        let found = false;
        for (const name of files) {
          const file = join(traceDir, name);
          assert.equal((await stat(file)).mode & 0o777, 0o600);
          const data = JSON.parse(await readFile(file, "utf8"));
          assert.ok(data.stage && data.response);
          if (JSON.stringify(data.response).includes("HIDDEN_SENTINEL"))
            found = true;
          assert.ok(!("request" in data));
        }
        assert.ok(found);
        assert.ok(!JSON.stringify(traced).includes("HIDDEN_SENTINEL"));
        assert.equal(
          await readFile(join(dir, "knowledge.ndjson"), "utf8"),
          original,
        );
      } finally {
        await rm(traced.retainedProject, { recursive: true, force: true });
      }
      const before = (await readdir(tmpdir()))
        .filter((x) => x.startsWith("memory-evaluation-"))
        .sort();
      const cleaned = await run({
        source,
        forwardEnv: ["MEMORY_REVIEW_PRIVATE_TRACE"],
        argv: [process.execPath, "--input-type=module", "-e", driver, "1"],
      });
      assert.ok(!("retainedProject" in cleaned));
      assert.deepEqual(
        (await readdir(tmpdir()))
          .filter((x) => x.startsWith("memory-evaluation-"))
          .sort(),
        before,
      );
    } finally {
      if (priorTrace === undefined)
        delete process.env.MEMORY_REVIEW_PRIVATE_TRACE;
      else process.env.MEMORY_REVIEW_PRIVATE_TRACE = priorTrace;
    }
    const cli = await run({
      source,
      argv: [
        process.execPath,
        new URL("./pi-reviewer-adapter.mjs", import.meta.url).pathname,
      ],
    });
    assert.equal(cli.reviewer.status, "error");
    assert.equal(cli.reviewer.calls, 0);
    assert.equal(cli.reviewer.errorCode, "model_not_configured");
    const auth = join(source, "test-auth.json");
    await writeFile(auth, "{}");
    const previousModel = process.env.MEMORY_REVIEW_MODEL;
    const previousAuth = process.env.MEMORY_REVIEW_AUTH_PATH;
    try {
      process.env.MEMORY_REVIEW_MODEL =
        "nonexistent-provider/nonexistent-model";
      process.env.MEMORY_REVIEW_AUTH_PATH = auth;
      const configured = await run({
        source,
        forwardEnv: ["MEMORY_REVIEW_MODEL", "MEMORY_REVIEW_AUTH_PATH"],
        argv: [
          process.execPath,
          new URL("./pi-reviewer-adapter.mjs", import.meta.url).pathname,
        ],
      });
      assert.equal(configured.reviewer.status, "error");
      assert.equal(configured.reviewer.calls, 0);
      assert.equal(configured.reviewer.errorCode, "model_unavailable");
      assert.equal(await readFile(auth, "utf8"), "{}");
      assert.equal(
        await readFile(join(dir, "knowledge.ndjson"), "utf8"),
        original,
      );
    } finally {
      if (previousModel === undefined) delete process.env.MEMORY_REVIEW_MODEL;
      else process.env.MEMORY_REVIEW_MODEL = previousModel;
      if (previousAuth === undefined)
        delete process.env.MEMORY_REVIEW_AUTH_PATH;
      else process.env.MEMORY_REVIEW_AUTH_PATH = previousAuth;
    }
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
