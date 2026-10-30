import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { run } from "./evaluate.mjs";

test("explicit cached catalog is copied and resolves offline without authentication or a provider call", async () => {
  const source = await mkdtemp(join(tmpdir(), "memory-eval-catalog-"));
  const priorModel = process.env.MEMORY_REVIEW_MODEL;
  const priorStore = process.env.MEMORY_REVIEW_MODELS_STORE_PATH;
  try {
    const dir = join(source, ".pi", "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "knowledge.ndjson"),
      JSON.stringify({
        id: randomUUID(),
        created: new Date().toISOString(),
        content: "A local fixture fact.",
      }) + "\n",
    );
    await writeFile(join(dir, "practices.ndjson"), "");
    await writeFile(join(dir, "decisions.ndjson"), "");
    const runtime = await ModelRuntime.create({
      authPath: join(source, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const base = runtime.getModels("openai-codex")[0];
    assert.ok(base);
    const cache = join(source, "catalog.json");
    const contents = JSON.stringify({
      "openai-codex": {
        models: [{ ...base, id: "fixture-model-only-in-cache" }],
        checkedAt: Date.now(),
        lastModified: 9999999999999,
      },
    });
    await writeFile(cache, contents);
    process.env.MEMORY_REVIEW_MODEL =
      "openai-codex/fixture-model-only-in-cache";
    process.env.MEMORY_REVIEW_MODELS_STORE_PATH = cache;
    const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
    const adapter = new URL("./pi-reviewer-adapter.mjs", import.meta.url).href;
    const driver = `import {ModelRegistry} from ${JSON.stringify(sdk)}; ModelRegistry.prototype.getApiKeyAndHeaders=async()=>({ok:false,error:'synthetic'}); ModelRegistry.prototype.complete=async()=>{throw new Error('unexpected provider call')}; const {execute}=await import(${JSON.stringify(adapter)}); await execute({project:process.env.MEMORY_EVALUATION_PROJECT,nonce:process.env.MEMORY_EVALUATION_NONCE,modelName:process.env.MEMORY_REVIEW_MODEL,modelsStorePath:process.env.MEMORY_REVIEW_MODELS_STORE_PATH});`;
    const result = await run({
      source,
      forwardEnv: ["MEMORY_REVIEW_MODEL", "MEMORY_REVIEW_MODELS_STORE_PATH"],
      argv: [process.execPath, "--input-type=module", "-e", driver],
    });
    assert.equal(result.reviewer.status, "error");
    assert.equal(result.reviewer.errorCode, "auth_unavailable");
    assert.equal(result.reviewer.calls, 0);
    const fakeResponseDriver = driver.replace(
      "ModelRegistry.prototype.getApiKeyAndHeaders=async()=>({ok:false,error:'synthetic'}); ModelRegistry.prototype.complete=async()=>{throw new Error('unexpected provider call')}",
      "ModelRegistry.prototype.getApiKeyAndHeaders=async()=>({ok:true}); ModelRegistry.prototype.complete=async(_model,ctx)=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify(ctx.systemPrompt.includes('Select evidence')?{paths:[]}:{action:'no_change',reason:'private fake reason',evidenceSufficient:false})}]})",
    );
    const fakeResult = await run({
      source,
      forwardEnv: ["MEMORY_REVIEW_MODEL", "MEMORY_REVIEW_MODELS_STORE_PATH"],
      argv: [process.execPath, "--input-type=module", "-e", fakeResponseDriver],
    });
    assert.ok(
      fakeResult.reviewer.diagnostics.entries.some(
        (entry) =>
          entry.stage === "decision" && entry.evidenceSufficient.false === 1,
      ),
    );
    assert.ok(!JSON.stringify(fakeResult).includes("private fake reason"));
    assert.equal(await readFile(cache, "utf8"), contents);
  } finally {
    if (priorModel === undefined) delete process.env.MEMORY_REVIEW_MODEL;
    else process.env.MEMORY_REVIEW_MODEL = priorModel;
    if (priorStore === undefined)
      delete process.env.MEMORY_REVIEW_MODELS_STORE_PATH;
    else process.env.MEMORY_REVIEW_MODELS_STORE_PATH = priorStore;
    await rm(source, { recursive: true, force: true });
  }
});
