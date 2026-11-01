import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.ts";
import { createManagedBrowserExtension } from "./registration.ts";

test("large action and dialog operation results retain dispatch status and owner-scoped full output", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "action-artifact-")),
  );
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
  let active: string[] = [],
    quota = 1_000_000,
    dispatched = 0;
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  };
  let stored: any;
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createArtifacts: () =>
      new ArtifactStore({ root: join(root, "artifacts"), quota }),
    createSessions: () =>
      ({
        action: async (_target: unknown, _owner: string, args: any) => {
          dispatched++;
          stored = {
            target: { sessionId: "s", tabId: "t" },
            action: args.action,
            element: args.target,
            status:
              args.action === "click" ? "completed" : "possibly_dispatched",
            verification:
              args.action === "click" ? "verified_condition" : "unconfirmed",
            ...(args.action === "fill"
              ? {
                  note: "The action may have occurred; no automatic retry was made.",
                }
              : {}),
          };
          return stored;
        },
        dialog: async () => ({
          target: { sessionId: "s", tabId: "t" },
          operationId: "op",
          status: "settled",
          result: stored,
        }),
        shutdown: async () => ({ complete: true }),
      }) as never,
  });
  const ctx = (owner: string) => ({
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => owner },
  });
  const call = async (name: string, args: any, owner = "owner") =>
    JSON.parse(
      (
        await tools
          .get(name)
          .execute("id", args, undefined, undefined, ctx(owner))
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
      if (chunk.nextOffset === null) return JSON.parse(text);
      offset = chunk.nextOffset;
    }
  };
  try {
    await handlers.get("session_start")!({}, ctx("owner"));
    const small = await call("browser_action", {
      action: "click",
      target: { selector: "#ok" },
    });
    assert.deepEqual(small, stored);
    const complete = await call("browser_action", {
      action: "click",
      target: { selector: "#" + "a".repeat(20000) },
    });
    assert.equal(complete.status, "completed");
    assert.equal(complete.verification, "verified_condition");
    assert.match(complete.dispatchWarning, /do not automatically retry/);
    assert.deepEqual(await readAll(complete.artifact.id), stored);
    await assert.rejects(
      call(
        "browser_artifact",
        { action: "read", id: complete.artifact.id },
        "foreign",
      ),
      /owned by another/,
    );
    const uncertain = await call("browser_action", {
      action: "fill",
      target: { role: "button", name: "n".repeat(20000) },
      value: "x",
    });
    assert.equal(uncertain.status, "possibly_dispatched");
    assert.equal(uncertain.verification, "unconfirmed");
    assert.deepEqual(await readAll(uncertain.artifact.id), stored);
    const operation = await call("browser_dialog", {
      action: "operation",
      operationId: "op",
    });
    assert.equal(operation.status, "settled");
    assert.equal(operation.result.status, "possibly_dispatched");
    assert.equal(operation.result.verification, "unconfirmed");
    assert.deepEqual((await readAll(operation.artifact.id)).result, stored);
    await handlers.get("session_shutdown")!({}, ctx("owner"));
    quota = 1024;
    await handlers.get("session_start")!({}, ctx("owner"));
    const failedArtifact = await call("browser_action", {
      action: "click",
      target: { selector: "#" + "x".repeat(20000) },
    });
    assert.equal(failedArtifact.status, "completed");
    assert.equal(failedArtifact.verification, "verified_condition");
    assert.equal(failedArtifact.artifactSaved, false);
    assert.match(failedArtifact.artifactError, /quota exceeded/i);
    assert.match(failedArtifact.dispatchWarning, /may have occurred/);
    const uncertainFailure = await call("browser_action", {
      action: "fill",
      target: { role: "button", name: "n".repeat(20000) },
      value: "x",
    });
    assert.equal(uncertainFailure.status, "possibly_dispatched");
    assert.equal(uncertainFailure.verification, "unconfirmed");
    assert.match(uncertainFailure.artifactError, /quota exceeded/i);
    assert.equal(dispatched, 5);
    const dialogFailure = await call("browser_dialog", {
      action: "operation",
      operationId: "op",
    });
    assert.equal(dialogFailure.result.status, "possibly_dispatched");
    assert.equal(dialogFailure.result.verification, "unconfirmed");
    assert.match(dialogFailure.artifactError, /quota exceeded/i);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx("owner"));
    await rm(root, { recursive: true, force: true });
  }
});
