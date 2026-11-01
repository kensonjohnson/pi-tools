import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.ts";
import { createManagedBrowserExtension } from "./registration.ts";

test("large snapshots and recovery lists remain complete owner-scoped artifacts", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "browser-large-structured-")),
  );
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  let active: string[] = [];
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  };
  const records = Array.from({ length: 500 }, (_, i) => ({
    ref: `r${i}`,
    role: "button",
    name: `Button ${i} with descriptive metadata`,
  }));
  const snapshot = {
    target: { sessionId: "s", tabId: "t" },
    snapshot: { records, complete: true },
  };
  const entries = Array.from({ length: 500 }, (_, i) => ({
    sessionId: "s",
    status: "closure_unknown",
    path: `/private/owner-a/upload-${i}`,
  }));
  const recovery = { entries, pendingPreparations: 0, note: "Recovery" };
  let quota = 1000000;
  let capturedOptions: unknown;
  let overrideSnapshot: unknown;
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createArtifacts: () =>
      new ArtifactStore({ root: join(root, "artifacts"), quota }),
    createSessions: () =>
      ({
        snapshot: async (
          _target: unknown,
          _owner: string,
          _signal: unknown,
          options: unknown,
        ) => {
          capturedOptions = options;
          return overrideSnapshot ?? snapshot;
        },
        validateSnapshotRef: async (
          _target: unknown,
          owner: string,
          ref: string,
        ) => ({ owner, ref, valid: records.some((item) => item.ref === ref) }),
        uploadRecovery: (owner: string) =>
          owner === "a"
            ? recovery
            : { entries: [], pendingPreparations: 0, note: "Recovery" },
        shutdown: async () => ({ complete: true }),
      }) as never,
    createInstaller: () => ({}) as never,
  });
  const ctx = (id: string) => ({
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
  });
  const call = async (name: string, args: unknown, owner = "a") =>
    JSON.parse(
      (
        await tools
          .get(name)
          .execute("call", args, undefined, undefined, ctx(owner))
      ).content[0].text,
    );
  const readAll = async (id: string) => {
    let offset = 0,
      text = "";
    for (;;) {
      const chunk = await call("browser_artifact", {
        action: "read",
        id,
        offset,
      });
      text += chunk.text;
      if (chunk.nextOffset === null) return text;
      offset = chunk.nextOffset;
    }
  };
  try {
    await handlers.get("session_start")!({}, ctx("a"));
    const rendered = await call("browser_snapshot", {
      maxRecords: 500,
      maxChars: 200000,
      identityNameChars: 1600,
      identityAncestors: 250,
      maxScopeNodes: 40000,
    });
    assert.equal(rendered.complete, false);
    assert.equal(rendered.representation, "json");
    assert.deepEqual(capturedOptions, {
      selector: undefined,
      frameSelector: undefined,
      maxNodes: undefined,
      maxRecords: 500,
      maxChars: 200000,
      maxFrames: undefined,
      identityNameChars: 1600,
      identityAncestors: 250,
      maxScopeNodes: 40000,
    });
    const restored = JSON.parse(await readAll(rendered.artifact.id));
    assert.deepEqual(restored, snapshot);
    const validated = await call("browser_snapshot_ref", {
      ref: restored.snapshot.records[499].ref,
    });
    assert.deepEqual(validated, { owner: "a", ref: "r499", valid: true });
    await assert.rejects(
      call(
        "browser_artifact",
        { action: "read", id: rendered.artifact.id },
        "b",
      ),
      /owned by another/,
    );
    const large = await call("browser_session", { action: "upload_recovery" });
    assert.equal(large.complete, false);
    assert.deepEqual(JSON.parse(await readAll(large.artifact.id)), recovery);
    await assert.rejects(
      call("browser_artifact", { action: "read", id: large.artifact.id }, "b"),
      /owned by another/,
    );
    assert.deepEqual(
      await call("browser_session", { action: "upload_recovery" }, "b"),
      { entries: [], pendingPreparations: 0, note: "Recovery" },
    );
    overrideSnapshot = { text: "x".repeat(15989) };
    assert.equal(Buffer.byteLength(JSON.stringify(overrideSnapshot)), 16000);
    assert.deepEqual(await call("browser_snapshot", {}), overrideSnapshot);
    overrideSnapshot = { text: "x".repeat(15990) };
    assert.equal(Buffer.byteLength(JSON.stringify(overrideSnapshot)), 16001);
    const boundary = await call("browser_snapshot", {});
    assert.equal(boundary.complete, false);
    assert.deepEqual(
      JSON.parse(await readAll(boundary.artifact.id)),
      overrideSnapshot,
    );
    overrideSnapshot = undefined;
    await handlers.get("session_shutdown")!({}, ctx("a"));
    quota = 1024;
    await handlers.get("session_start")!({}, ctx("a"));
    await assert.rejects(
      call("browser_snapshot", { maxRecords: 500 }),
      /Artifact quota exceeded/,
    );
    await assert.rejects(
      call("browser_session", { action: "upload_recovery" }),
      /Artifact quota exceeded/,
    );
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx("a"));
    await rm(root, { recursive: true, force: true });
  }
});
