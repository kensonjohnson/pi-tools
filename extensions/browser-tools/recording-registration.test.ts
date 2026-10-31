import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";
import { createRecordingDirectory } from "./recording-recovery.ts";
import { Value } from "@sinclair/typebox/value";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

test("registration forwards creation-time video and never relaunches on enable request", async () => {
  const tools = new Map<string, any>(),
    handlers = new Map<string, Function>();
  let active: string[] = [],
    starts = 0,
    options: any;
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
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createInstaller: () => ({ ensure: async () => ({ ok: true }) }) as never,
    createSessions: () =>
      ({
        start: async (value: any) => {
          starts++;
          options = value;
          return { sessionId: "s", tabId: "t" };
        },
        shutdown: async () => ({ complete: true }),
      }) as never,
  });
  const owner = randomUUID();
  const recoveryDir = await createRecordingDirectory("trace", owner);
  const extraDirs: string[] = [];
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => owner },
  };
  await handlers.get("session_start")!({}, ctx);
  try {
    const started = await tools
      .get("browser_session")
      .execute(
        "id",
        { action: "start", video: true },
        undefined,
        undefined,
        ctx,
      );
    const startResult = JSON.parse(started.content[0].text);
    assert.equal(startResult.videoDeadline.durationMs, 300000);
    assert.match(startResult.videoDeadline.warning, /may be lost/);
    assert.equal(options.video, true);
    assert.equal(options.artifactOwner, owner);
    const recovery = await tools
      .get("browser_recording")
      .execute("id", { action: "recovery" }, undefined, undefined, ctx);
    assert.ok(
      JSON.parse(recovery.content[0].text).items.some(
        (item: { path: string }) => item.path === recoveryDir,
      ),
    );
    for (let i = 0; i < 122; i++)
      extraDirs.push(await createRecordingDirectory("video", owner));
    const tool = tools.get("browser_recording");
    let offset = 0;
    const paths: string[] = [];
    do {
      const args = { action: "recovery", offset, limit: 20 };
      assert.equal(
        Value.Check(tool.parameters, args),
        true,
        `schema rejects offset ${offset}`,
      );
      const response = await tool.execute(
        "id",
        args,
        undefined,
        undefined,
        ctx,
      );
      const page = JSON.parse(response.content[0].text);
      assert.equal(page.truncated, page.nextOffset !== null);
      paths.push(...page.items.map((item: { path: string }) => item.path));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
    assert.ok(offset >= 120);
    assert.deepEqual(new Set(paths), new Set([recoveryDir, ...extraDirs]));
    const wide = JSON.parse(
      (
        await tool.execute(
          "id",
          { action: "recovery", limit: 1000 },
          undefined,
          undefined,
          ctx,
        )
      ).content[0].text,
    );
    if (wide.artifact) {
      let offset = 0,
        text = "";
      for (;;) {
        const chunk = JSON.parse(
          (
            await tools
              .get("browser_artifact")
              .execute(
                "id",
                { action: "read", id: wide.artifact.id, offset },
                undefined,
                undefined,
                ctx,
              )
          ).content[0].text,
        );
        text += chunk.text;
        if (chunk.nextOffset === null) break;
        offset = chunk.nextOffset;
      }
      assert.equal(JSON.parse(text).items.length, 123);
      await assert.rejects(
        tools
          .get("browser_artifact")
          .execute(
            "id",
            { action: "read", id: wide.artifact.id },
            undefined,
            undefined,
            { ...ctx, sessionManager: { getSessionId: () => "foreign" } },
          ),
        /owned by another/,
      );
    } else assert.equal(wide.items.length, 123);
    assert.equal(
      Value.Check(tool.parameters, {
        action: "recovery",
        offset: 10001,
        limit: 1000,
      }),
      true,
    );
    await assert.rejects(
      tools
        .get("browser_recording")
        .execute(
          "id",
          { action: "enable_video", sessionId: "s" },
          undefined,
          undefined,
          ctx,
        ),
      /new recording-enabled session/,
    );
    assert.equal(starts, 1);
    await assert.rejects(
      tools
        .get("browser_recording")
        .execute(
          "id",
          { action: "inspect_video", sessionId: "s" },
          undefined,
          undefined,
          ctx,
        ),
      /unavailable/,
    );
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
    await rm(recoveryDir, { recursive: true, force: true });
    await Promise.all(
      extraDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }
});
