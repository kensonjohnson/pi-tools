import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.ts";
import { createManagedBrowserExtension } from "./registration.ts";

test("owner-scoped artifact pages enumerate all entries without creating listing artifacts", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "artifact-pages-")));
  const store = new ArtifactStore({ root: join(root, "store") });
  const handlers = new Map<string, Function>(),
    tools = new Map<string, any>();
  let active: string[] = [];
  const pi = {
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on: (n: string, f: Function) => handlers.set(n, f),
    registerTool: (t: any) => {
      tools.set(t.name, t);
      active.push(t.name);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  };
  const ctx = (id: string) => ({
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id },
  });
  createManagedBrowserExtension(pi as never, {
    loadSettings: async () => ({ values: {} }) as never,
    createArtifacts: () => store,
    createSessions: () =>
      ({ shutdown: async () => ({ complete: true }) }) as never,
  });
  try {
    const expected: string[] = [];
    for (let i = 0; i < 105; i++)
      expected.push((await store.put("owner", `value-${i}`)).id);
    const other = await store.put("other", "private");
    await handlers.get("session_start")!({}, ctx("owner"));
    const page = async (args: object, owner = "owner") =>
      JSON.parse(
        (
          await tools
            .get("browser_artifact")
            .execute(
              "id",
              { action: "list", ...args },
              undefined,
              undefined,
              ctx(owner),
            )
        ).content[0].text,
      );
    const first = await page({});
    assert.equal(first.artifacts.length, 100);
    assert.ok(first.nextAfterId);
    assert.equal(first.artifact, undefined);
    const second = await page({ afterId: first.nextAfterId });
    assert.equal(second.artifacts.length, 5);
    assert.equal(second.nextAfterId, null);
    assert.deepEqual(
      [...first.artifacts, ...second.artifacts].map((item: any) => item.id),
      expected.sort(),
    );
    assert.deepEqual(
      (await page({}, "other")).artifacts.map((item: any) => item.id),
      [other.id],
    );
    assert.equal((await store.cleanup()).count, 106);
    await assert.rejects(page({ afterId: "invalid" }), /cursor/);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx("owner"));
    await rm(root, { recursive: true, force: true });
  }
});
