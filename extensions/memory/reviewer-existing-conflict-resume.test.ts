import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { reviewProjectSessions } from "./scheduler.ts";

test("existing proposal conflict evidence is rebuilt after a fragment checkpoint restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-existing-conflict-"));
  const sessions = join(root, "sessions"),
    checkpointFile = join(root, ".pi", "progress", "state.json");
  try {
    await mkdir(sessions);
    await mkdir(join(root, ".pi", "memory"), { recursive: true });
    await writeFile(
      join(root, ".pi", "memory", "knowledge.ndjson"),
      [
        { id: "on", content: "Network mode is enabled.", created: "2025" },
        { id: "off", content: "Network mode is disabled.", created: "2025" },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    await writeFile(
      join(sessions, "one.jsonl"),
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: {
            role: "user",
            content:
              "prefix ".repeat(2000) +
              "Network mode is enabled. " +
              "tail ".repeat(2000),
          },
        },
        {
          type: "message",
          id: "b",
          parentId: "a",
          message: {
            role: "user",
            content: "Network mode is disabled. " + "tail ".repeat(2000),
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const run = async (abort: boolean) => {
      const store = new MemoryManager(root, { semanticEnabled: false });
      const controller = new AbortController();
      let enabledSeen = false,
        disabledSeen = false;
      try {
        await store.init();
        const reviewer = new MemoryReviewer({
          project: root,
          store,
          contextWindow: 3000,
          continuationKey: "test/mock",
          model: {
            generate: async ({ instruction, data }: any) => {
              if (instruction.startsWith("Select")) return { paths: [] };
              if (instruction.includes("Independently review duplicate"))
                return {
                  action: "no_change",
                  reason: "Reviewed.",
                  evidenceSufficient: true,
                };
              if (instruction.startsWith("Independently"))
                return { verdict: "supported", reason: "Direct." };
              const item = data.session.find((s: any) =>
                /Network mode is (?:enabled|disabled)/.test(s.text),
              );
              if (!item) {
                if (abort && enabledSeen) controller.abort();
                return {
                  action: "no_change",
                  reason: "Reviewed.",
                  evidenceSufficient: true,
                };
              }
              const enabled = item.text.includes("enabled");
              enabledSeen ||= enabled;
              disabledSeen ||= !enabled;
              return {
                action: "add",
                category: "knowledge",
                content: `Network mode is ${enabled ? "enabled" : "disabled"}.`,
                reason: "Direct.",
                citation: { kind: "session", id: item.id, quote: item.text },
              };
            },
          },
        });
        const result = await reviewProjectSessions({
          project: root,
          sessionDir: sessions,
          checkpointFile,
          reviewer,
          signal: controller.signal,
        });
        return { result, enabledSeen, disabledSeen };
      } finally {
        await store.close();
      }
    };
    await assert.rejects(run(true));
    const retry = await run(false);
    assert.equal(retry.enabledSeen, true);
    assert.equal(retry.disabledSeen, true);
    assert.equal(retry.result.status, "unresolved");
    await assert.rejects(access(checkpointFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
