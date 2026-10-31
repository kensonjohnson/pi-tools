import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { MemoryManager } from "./core.ts";

test("duplicate removal rejects changed retained records and preserves the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-duplicate-condition-"));
  const manager = new MemoryManager(root, { semanticEnabled: false });
  const proto = MemoryManager.prototype;
  const original = {
    ready: proto.isReady,
    capture: proto.captureWritePrecondition,
    snapshot: proto.captureAddPrecondition,
    forget: proto.forgetWithSnapshot,
  };
  const tools = new Map<string, any>();
  let race = false;
  try {
    await manager.init(false, false);
    const target = (await manager.remember("knowledge", "duplicate")).memory;
    const retained = (await manager.remember("decisions", "retained")).memory;
    const retainedFile = join(root, ".pi/memory/decisions.ndjson");
    const targetFile = join(root, ".pi/memory/knowledge.ndjson");
    const targetBytes = await readFile(targetFile, "utf8");
    proto.isReady = async () => true;
    proto.captureWritePrecondition = (id) => original.capture.call(manager, id);
    proto.captureAddPrecondition = () => original.snapshot.call(manager);
    proto.forgetWithSnapshot = async (id, expected, snapshot) => {
      if (race) {
        const entry = JSON.parse(await readFile(retainedFile, "utf8"));
        await writeFile(
          retainedFile,
          `${JSON.stringify({ ...entry, content: "concurrent" })}\n`,
        );
      }
      return original.forget.call(manager, id, expected, snapshot);
    };
    extension({
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on() {},
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
    } as any);
    const ctx = { cwd: root, isProjectTrusted: () => true };
    const params = {
      id: target.id,
      expectedContent: "duplicate",
      retainedId: retained.id,
      expectedRetainedContent: "retained",
    };
    const call = (p: object) =>
      tools.get("memory_forget").execute("", p, undefined, undefined, ctx);
    await assert.rejects(
      call({ ...params, expectedRetainedContent: "stale" }),
      /retained.*changed/,
    );
    await assert.rejects(
      call({ id: target.id, retainedId: retained.id }),
      /requires/,
    );
    race = true;
    await assert.rejects(call(params), /conflict/i);
    assert.equal(await readFile(targetFile, "utf8"), targetBytes);
    assert.equal(
      JSON.parse(await readFile(retainedFile, "utf8")).content,
      "concurrent",
    );
    race = false;
    await call({ ...params, expectedRetainedContent: "concurrent" });
    assert.equal(await readFile(targetFile, "utf8"), "");
  } finally {
    proto.isReady = original.ready;
    proto.captureWritePrecondition = original.capture;
    proto.captureAddPrecondition = original.snapshot;
    proto.forgetWithSnapshot = original.forget;
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
