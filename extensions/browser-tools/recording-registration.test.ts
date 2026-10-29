import { test } from "node:test";
import assert from "node:assert/strict";
import { createManagedBrowserExtension } from "./registration.ts";
import {
  createRecordingDirectory,
  RECORDING_RECOVERY_SCAN_LIMIT,
} from "./recording-recovery.ts";
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
    await tools
      .get("browser_session")
      .execute(
        "id",
        { action: "start", video: true },
        undefined,
        undefined,
        ctx,
      );
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
      assert.equal(page.scanLimit, RECORDING_RECOVERY_SCAN_LIMIT);
      assert.equal(page.truncated, false);
      paths.push(...page.items.map((item: { path: string }) => item.path));
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
    assert.ok(offset >= 120);
    assert.deepEqual(new Set(paths), new Set([recoveryDir, ...extraDirs]));
    assert.equal(
      Value.Check(tool.parameters, {
        action: "recovery",
        offset: RECORDING_RECOVERY_SCAN_LIMIT + 1,
      }),
      false,
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
