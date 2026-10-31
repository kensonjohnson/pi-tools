import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { registerExtensionSettings } from "../../lib/pi-tools-config.ts";
import { MemoryManager } from "./core.ts";
import { createConfiguredPiMemoryReviewer } from "./reviewer.ts";

test("configured trusted-project reviewer uses the selected registry model without fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-config-"));
  const agent = await mkdtemp(join(tmpdir(), "review-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const store = new MemoryManager(cwd, { semanticEnabled: false });
  try {
    registerExtensionSettings({
      id: "memory",
      label: "Memory",
      fields: {
        enabled: { type: "boolean", default: true },
        "models.reviewer": { type: "string", default: "" },
      },
    });
    await store.init();
    await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "pi-tools.json"),
      JSON.stringify({
        version: 1,
        extensions: { memory: { models: { reviewer: "p/reviewer" } } },
      }),
    );
    let calls = 0;
    const ctx: any = {
      cwd,
      isProjectTrusted: () => true,
      modelRegistry: {
        find(provider: string, id: string) {
          assert.equal(provider, "p");
          assert.equal(id, "reviewer");
          return { provider, id, input: ["text"] };
        },
        async getApiKeyAndHeaders() {
          return { ok: true };
        },
        async complete(_model: unknown, context: any) {
          calls++;
          assert.equal(context.tools, undefined);
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
      },
    };
    const reviewer = await createConfiguredPiMemoryReviewer(ctx, store);
    assert.equal((await reviewer.review()).status, "unchanged");
    assert.equal(calls, 3);
    ctx.isProjectTrusted = () => false;
    await assert.rejects(createConfiguredPiMemoryReviewer(ctx, store), /trust/);
  } finally {
    await store.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
    await rm(agent, { recursive: true, force: true });
  }
});
