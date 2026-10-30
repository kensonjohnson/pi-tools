#!/usr/bin/env node
// This module is loaded from the trusted source checkout for dependencies only.
// The reviewer store and repository evidence always use the marked disposable copy.
import {
  realpath,
  lstat,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  chmod,
} from "node:fs/promises";
import { join, resolve, sep, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryManager } from "../../extensions/memory/core.ts";
import { MemoryReviewer } from "../../extensions/memory/reviewer.ts";
import { PiReviewerModel } from "../../extensions/memory/reviewer-model.ts";
import { summarize, summarizeOutcome } from "./diagnostics.mjs";
import { reviewAllMemories } from "../../extensions/memory/manual-review.ts";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function validateProject(project, nonce) {
  if (!project || !nonce || !/^[a-f0-9]{64}$/.test(nonce))
    throw new Error("Missing evaluation marker");
  const root = await realpath(project);
  const source = await realpath(checkout);
  const cwd = await realpath(process.cwd());
  if (
    root !== resolve(project) ||
    root !== cwd ||
    root === source ||
    root.startsWith(source + sep) ||
    source.startsWith(root + sep)
  )
    throw new Error("Project is not an isolated evaluation directory");
  for (const name of [
    ".memory-evaluation-marker",
    ".pi",
    ".pi/memory",
    ".pi/memory/knowledge.ndjson",
    ".pi/memory/practices.ndjson",
    ".pi/memory/decisions.ndjson",
  ]) {
    const p = join(root, name);
    const info = await lstat(p);
    if (info.isSymbolicLink() || (await realpath(p)) !== p)
      throw new Error("Evaluation path contains a symlink");
  }
  if (
    (await readFile(join(root, ".memory-evaluation-marker"), "utf8")) !== nonce
  )
    throw new Error("Evaluation marker mismatch");
  return root;
}
function numberOption(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max)
    throw new Error("Invalid execution limit");
  return Number(value);
}

export function runtimeOptions(
  runtimeDir,
  signal,
  authPath,
  modelsPath,
  modelsStorePath,
) {
  for (const path of [authPath, modelsPath, modelsStorePath]) {
    if (path !== undefined && (!path || !isAbsolute(path)))
      throw new Error("Explicit Pi config paths must be absolute");
  }
  return {
    authPath: authPath ?? join(runtimeDir, "auth.json"),
    modelsPath:
      modelsPath ??
      (modelsStorePath ? join(runtimeDir, "empty-models.json") : null),
    modelsStorePath: modelsStorePath ?? join(runtimeDir, "models-store.json"),
    allowModelNetwork: false,
    signal,
  };
}

// Injectable fake model is used only by tests. CLI always uses PiReviewerModel.
export async function execute({
  project,
  nonce,
  modelName,
  model,
  authPath,
  modelsPath,
  modelsStorePath,
  privateTrace = false,
  maxCalls = 20,
  maxPasses = 12,
  timeoutMs = 120000,
}) {
  const root = await validateProject(project, nonce);
  let calls = 0,
    pages = 0,
    changes = null,
    coverage = null,
    limit = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    limit = true;
    controller.abort();
  }, timeoutMs);
  const store = new MemoryManager(root, { semanticEnabled: false });
  let status = "error",
    errorCode = "setup_failed";
  const diagnostics = {
    entries: [],
    omitted: 0,
    reviewOutcomes: [],
    reviewOutcomesOmitted: 0,
  };
  const runtimeDir = join(root, ".evaluation-runtime");
  let traceSequence = 0;
  const instrument = (inner) => ({
    generate: async (request) => {
      try {
        const result = await inner.generate(request);
        const summary = summarize(request, result);
        if (privateTrace) {
          const name = `private-trace-${String(++traceSequence).padStart(6, "0")}.json`;
          await writeFile(
            join(runtimeDir, name),
            JSON.stringify({ stage: summary, response: result }),
            { mode: 0o600, flag: "wx" },
          );
        }
        if (diagnostics.entries.length < 200) diagnostics.entries.push(summary);
        else diagnostics.omitted++;
        return result;
      } catch (error) {
        if (diagnostics.entries.length < 200)
          diagnostics.entries.push(summarize(request, undefined, true));
        else diagnostics.omitted++;
        throw error;
      }
    },
  });
  try {
    if (privateTrace) await mkdir(runtimeDir, { mode: 0o700 });
    await store.init();
    let reviewer;
    if (model) {
      const bounded = {
        generate: async (request) => {
          if (calls >= maxCalls) {
            limit = true;
            throw new Error("Model call limit");
          }
          calls++;
          return model.generate(request);
        },
      };
      reviewer = new MemoryReviewer({
        project: root,
        store,
        model: instrument(bounded),
        contextWindow: 10000,
      });
    } else {
      if (!modelName || !/^[^/\s]+\/\S+$/.test(modelName))
        throw new Error("Explicit provider/model required");
      if (!privateTrace) await mkdir(runtimeDir, { mode: 0o700 });
      let privateStore;
      if (modelsStorePath !== undefined) {
        if (
          !isAbsolute(modelsStorePath) ||
          !(await lstat(modelsStorePath)).isFile()
        )
          throw new Error("Invalid models store path");
        privateStore = join(runtimeDir, "models-store.json");
        await copyFile(modelsStorePath, privateStore);
        await chmod(privateStore, 0o600);
        if (!modelsPath)
          await writeFile(join(runtimeDir, "empty-models.json"), "{}", {
            mode: 0o600,
          });
      }
      const runtime = await ModelRuntime.create(
        runtimeOptions(
          runtimeDir,
          controller.signal,
          authPath,
          modelsPath,
          privateStore,
        ),
      );
      const registry = new ModelRegistry(runtime);
      // Bound actual registry calls rather than review passes: one pass can invoke many calls.
      const complete = registry.complete.bind(registry);
      registry.complete = async (...args) => {
        if (calls >= maxCalls) {
          limit = true;
          throw new Error("Model call limit");
        }
        calls++;
        return complete(...args);
      };
      const slash = modelName.indexOf("/");
      const lookup = () =>
        registry.find(modelName.slice(0, slash), modelName.slice(slash + 1));
      reviewer = new MemoryReviewer({
        project: root,
        store,
        model: instrument(new PiReviewerModel(registry, modelName)),
        continuationKey: modelName,
        contextWindow: () => lookup()?.contextWindow,
        maxOutputTokens: () => lookup()?.maxTokens,
      });
    }
    const review = reviewer.review.bind(reviewer);
    reviewer.review = async (options) => {
      const result = await review(options);
      if (diagnostics.reviewOutcomes.length < 200)
        diagnostics.reviewOutcomes.push(summarizeOutcome(result));
      else diagnostics.reviewOutcomesOmitted++;
      return result;
    };
    const outcome = await reviewAllMemories({
      reviewer,
      signal: controller.signal,
      maxPasses,
    });
    diagnostics.finalOutcome = summarizeOutcome(outcome);
    status = outcome.status;
    pages = outcome.review?.pages ?? 0;
    changes = outcome.changes?.length ?? 0;
    if (outcome.review) {
      coverage = {};
      for (const key of [
        "evidenceGaps",
        "limitedPages",
        "discoveryTruncatedPages",
        "searchIncompletePages",
        "candidatesTruncatedPages",
        "memoryEvaluations",
        "snapshotMemories",
      ]) {
        const value = outcome.review[key];
        if (Number.isSafeInteger(value) && value >= 0) coverage[key] = value;
      }
      const reasons = outcome.review.gapReasons;
      if (reasons && typeof reasons === "object") {
        coverage.gapReasons = {};
        for (const key of [
          "model_insufficient",
          "missing_reason",
          "no_evidence",
          "evidence_failures",
          "requests_truncated",
          "search_incomplete",
          "fragment_insufficient",
        ]) {
          const value = reasons[key];
          if (Number.isSafeInteger(value) && value >= 0)
            coverage.gapReasons[key] = value;
        }
      }
    }
    if (status === "pending") limit = true;
  } catch (error) {
    // Only exact host-generated messages map to codes; never expose exception text.
    const message = error instanceof Error ? error.message : "";
    if (message === "review model unavailable or not a chat model")
      errorCode = "model_unavailable";
    else if (message === "review model authentication unavailable")
      errorCode = "auth_unavailable";
    else if (message === "review model lacks text input capability")
      errorCode = "model_not_text";
    else if (message === "Explicit provider/model required")
      errorCode = "model_not_configured";
    else if (
      message === "Invalid models store path" ||
      message === "Explicit Pi config paths must be absolute"
    )
      errorCode = "config_invalid";
    else if (calls > 0) errorCode = "review_failed";
    status = limit ? "pending" : "error";
  } finally {
    clearTimeout(timer);
    await store.close();
  }
  const report = {
    status,
    calls,
    pages,
    changes,
    coverage,
    diagnostics,
    ...(limit ? { reason: "limit" } : {}),
    ...(status === "error" ? { errorCode } : {}),
  };
  await writeFile(
    join(root, ".memory-evaluation-outcome.json"),
    JSON.stringify(report),
    { mode: 0o600, flag: "wx" },
  );
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await execute({
      project: process.env.MEMORY_EVALUATION_PROJECT,
      nonce: process.env.MEMORY_EVALUATION_NONCE,
      modelName: process.env.MEMORY_REVIEW_MODEL,
      authPath: process.env.MEMORY_REVIEW_AUTH_PATH,
      modelsPath: process.env.MEMORY_REVIEW_MODELS_PATH,
      modelsStorePath: process.env.MEMORY_REVIEW_MODELS_STORE_PATH,
      privateTrace: process.env.MEMORY_REVIEW_PRIVATE_TRACE === "1",
      maxCalls: numberOption(process.env.MEMORY_REVIEW_MAX_CALLS, 20, 1000),
      maxPasses: numberOption(process.env.MEMORY_REVIEW_MAX_PASSES, 12, 1000),
      timeoutMs: numberOption(
        process.env.MEMORY_REVIEW_TIMEOUT_MS,
        120000,
        3600000,
      ),
    });
    // No raw model or memory contents. Harness reads the outcome file.
    console.log(JSON.stringify(result));
  } catch {
    console.error("Evaluation adapter failed validation or setup");
    process.exitCode = 1;
  }
}
