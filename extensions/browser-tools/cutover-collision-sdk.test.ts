import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createManagedBrowserExtension } from "./registration.ts";

async function setup(factories: any[]) {
  const dir = await mkdtemp(join(tmpdir(), "browser-collision-sdk-"));
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: factories,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory(),
    noTools: true,
  });
  await session.bindExtensions({});
  return {
    session,
    async close() {
      await (session as any)._extensionRunner.emit({
        type: "session_shutdown",
      });
      session.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
function foreign(description: string) {
  return (pi: any) =>
    pi.registerTool({
      name: "browser_navigate",
      label: "foreign",
      description,
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: description }],
        details: undefined,
      }),
    });
}

test("Pi duplicate names use first extension registration", async () => {
  for (const order of [
    ["first", "second"],
    ["second", "first"],
  ]) {
    const fixture = await setup(order.map(foreign));
    try {
      assert.equal(
        fixture.session.getToolDefinition("browser_navigate")?.description,
        order[0],
      );
    } finally {
      await fixture.close();
    }
  }
});

test("managed tools activate and deactivate when no names collide", async () => {
  const managed = (pi: any) =>
    createManagedBrowserExtension(pi, {
      loadSettings: async () => ({ values: {} }) as never,
    });
  const fixture = await setup([managed]);
  try {
    assert.ok(
      fixture.session.getActiveToolNames().includes("browser_navigate"),
    );
    await (fixture.session as any)._extensionRunner.emit({
      type: "session_shutdown",
    });
    assert.ok(
      !fixture.session.getActiveToolNames().includes("browser_navigate"),
    );
  } finally {
    await fixture.close();
  }
});

test("inactive foreign tool remains registered and inactive", async () => {
  const inactive = (pi: any) => {
    foreign("inactive foreign")(pi);
    pi.on("session_start", () =>
      pi.setActiveTools(
        pi
          .getActiveTools()
          .filter((name: string) => name !== "browser_navigate"),
      ),
    );
  };
  const managed = (pi: any) =>
    createManagedBrowserExtension(pi, {
      loadSettings: async () => ({ values: {} }) as never,
    });
  const fixture = await setup([inactive, managed]);
  try {
    assert.equal(
      fixture.session.getToolDefinition("browser_navigate")?.description,
      "inactive foreign",
    );
    assert.ok(
      !fixture.session.getActiveToolNames().includes("browser_navigate"),
    );
    await (fixture.session as any)._extensionRunner.emit({
      type: "session_shutdown",
    });
    assert.ok(
      !fixture.session.getActiveToolNames().includes("browser_navigate"),
    );
  } finally {
    await fixture.close();
  }
});

test("Pi hides a later colliding registration behind the first extension", async () => {
  let foreignPi: any;
  const managed = (pi: any) =>
    createManagedBrowserExtension(pi, {
      loadSettings: async () => ({ values: {} }) as never,
    });
  const delayed = (pi: any) => {
    foreignPi = pi;
  };
  const fixture = await setup([managed, delayed]);
  try {
    assert.notEqual(
      fixture.session.getToolDefinition("browser_navigate")?.description,
      "late foreign",
    );
    foreign("late foreign")(foreignPi);
    assert.notEqual(
      fixture.session.getToolDefinition("browser_navigate")?.description,
      "late foreign",
    );
    assert.equal(
      foreignPi
        .getAllTools()
        .filter((tool: any) => tool.name === "browser_navigate").length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

for (const first of [true, false])
  for (const enabled of [true, false]) {
    test(`managed browser preserves colliding foreign tool, foreign first=${first} enabled=${enabled}`, async () => {
      const managed = (pi: any) =>
        createManagedBrowserExtension(pi, {
          loadSettings: async () =>
            ({ values: { "browser-tools": { enabled } } }) as never,
        });
      const fixture = await setup(
        first
          ? [foreign("foreign toolkit"), managed]
          : [managed, foreign("foreign toolkit")],
      );
      try {
        assert.equal(
          fixture.session.getToolDefinition("browser_navigate")?.description,
          "foreign toolkit",
        );
        assert.ok(
          fixture.session.getActiveToolNames().includes("browser_navigate"),
        );
        assert.ok(
          !fixture.session.getActiveToolNames().includes("browser_session"),
        );
        await (fixture.session as any)._extensionRunner.emit({
          type: "session_shutdown",
        });
        assert.ok(
          fixture.session.getActiveToolNames().includes("browser_navigate"),
        );
        assert.equal(
          fixture.session.getToolDefinition("browser_navigate")?.description,
          "foreign toolkit",
        );
      } finally {
        await fixture.close();
      }
    });
  }
