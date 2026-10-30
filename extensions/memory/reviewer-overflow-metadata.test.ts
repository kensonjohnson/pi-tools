import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiMemoryReviewer } from "./reviewer.ts";

test("an output maximum as large as context does not itself block inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-output-metadata-"));
  try {
    const snapshots = {
      knowledge: { contents: "", mode: 0o600 },
      practices: { contents: "", mode: 0o600 },
      decisions: { contents: "", mode: 0o600 },
    };
    let calls = 0;
    const registry: any = {
      find: () => ({
        provider: "p",
        id: "m",
        input: ["text"],
        contextWindow: 3000,
        maxTokens: 3000,
      }),
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async (_model: any, context: any, options: any) => {
        calls++;
        assert.equal(Object.hasOwn(options, "maxTokens"), false);
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: context.systemPrompt.includes("Select evidence requests")
                ? '{"paths":[]}'
                : '{"action":"no_change","reason":"Reviewed.","evidenceSufficient":true}',
            },
          ],
        };
      },
    };
    const store: any = { captureAddPrecondition: async () => ({ snapshots }) };
    const reviewer = createPiMemoryReviewer({
      project: root,
      store,
      ctx: { modelRegistry: registry },
      configuredModel: "p/m",
    });
    assert.equal((await reviewer.review()).status, "unchanged");
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
