import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedBrowserExtension } from "./registration.ts";
import { ArtifactStore } from "./artifacts.ts";

test("staged inspection tools return bounded private references and creator-scoped chunks", async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "browser-registration-")),
  );
  try {
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
      on(name: string, fn: Function) {
        handlers.set(name, fn);
      },
      registerTool(tool: any) {
        tools.set(tool.name, tool);
        active.push(tool.name);
      },
      getActiveTools: () => active,
      setActiveTools(value: string[]) {
        active = value;
      },
    };
    const text = "秘密🙂".repeat(10000);
    createManagedBrowserExtension(pi as never, {
      loadSettings: async () => ({ values: {} }) as never,
      createArtifacts: () =>
        new ArtifactStore({ root: join(parent, "managed") }),
      createSessions: () =>
        ({
          content: async () => ({
            target: { sessionId: "s", tabId: "t" },
            html: text,
          }),
          evaluate: async () => ({
            target: { sessionId: "s", tabId: "t" },
            text: "secret",
            representation: "string",
          }),
          shutdown: async () => ({ complete: true }),
        }) as never,
      createInstaller: () => ({}) as never,
    });
    const context = (id: string) => ({
      cwd: parent,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => id },
    });
    await handlers.get("session_start")!({}, context("one"));
    const rendered = await tools
      .get("browser_content")
      .execute("call", {}, undefined);
    assert.equal(rendered.details, undefined);
    assert.ok(Buffer.byteLength(rendered.content[0].text) < 16384);
    const result = JSON.parse(rendered.content[0].text);
    assert.equal(result.complete, false);
    assert.match(result.scope, /iframe/);
    let offset = 0,
      assembled = "";
    for (;;) {
      const response = await tools
        .get("browser_artifact")
        .execute("call", { action: "read", id: result.artifact.id, offset });
      const chunk = JSON.parse(response.content[0].text);
      assembled += chunk.text;
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
    assert.equal(assembled, text);
    await assert.rejects(
      tools
        .get("browser_artifact")
        .execute(
          "call",
          { action: "read", id: result.artifact.id },
          undefined,
          undefined,
          context("two"),
        ),
      /owned by another/,
    );
    const dest = join(parent, "export");
    await tools.get("browser_artifact").execute("call", {
      action: "export",
      id: result.artifact.id,
      path: dest,
    });
    assert.equal(await readFile(dest, "utf8"), text);
    await handlers.get("session_start")!({}, context("two"));
    await assert.rejects(
      tools
        .get("browser_artifact")
        .execute("call", { action: "read", id: result.artifact.id }),
      /owned by another/,
    );
    await handlers.get("session_start")!({}, context("one"));
    const restored = await tools
      .get("browser_artifact")
      .execute("call", { action: "read", id: result.artifact.id });
    assert.equal(JSON.parse(restored.content[0].text).offset, 0);
    await handlers.get("session_shutdown")!();
    assert.deepEqual(active, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
