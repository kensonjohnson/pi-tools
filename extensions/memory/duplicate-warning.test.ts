import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "./index.ts";

for (const hasUI of [true, false]) {
  test(`duplicate IDs do not stop lifecycle hooks (${hasUI ? "UI" : "headless"})`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "memory-conflict-"));
    const dir = join(cwd, ".pi", "memory");
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const notices: string[] = [];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      await mkdir(dir, { recursive: true });
      const file = join(dir, "knowledge.ndjson");
      const record = (content: string) =>
        JSON.stringify({ id: "same-id", created: "2026-01-01", content });
      const bytes = `${record("first")}\n${record("second")}\n`;
      await writeFile(file, bytes);
      extension({
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
        },
        getActiveTools() {
          return [];
        },
        setActiveTools() {},
      } as any);
      const ctx: any = {
        cwd,
        hasUI,
        isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "session" },
        ui: {
          notify(message: string, kind: string) {
            assert.equal(kind, "warning");
            notices.push(message);
          },
        },
      };
      await handlers.get("session_start")!({}, ctx);
      assert.deepEqual(await readdir(dir), ["knowledge.ndjson"]);
      assert.equal(notices.length + errors.length, 0);
      const initial = await handlers.get("before_agent_start")!({}, ctx);
      assert.match(initial.message.content, /first/);
      assert.match(initial.message.content, /second/);
      assert.equal(
        await handlers.get("before_agent_start")!({}, ctx),
        undefined,
      );
      const warnings = hasUI ? notices : errors;
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Duplicate memory IDs: same-id/);
      assert.match(warnings[0], /knowledge\.ndjson:1/);
      assert.match(warnings[0], /manually/);
      const recall = await tools
        .get("memory_recall")
        .execute("", { query: "not-present" }, undefined, undefined, ctx);
      assert.match(recall.content[0].text, /Duplicate memory id same-id/);
      assert.match(recall.content[0].text, /Search mode: grep/);
      assert.match(
        recall.content[0].text,
        /case-insensitive literal substring matching/,
      );
      const matched = await tools
        .get("memory_recall")
        .execute("", { query: "first" }, undefined, undefined, ctx);
      assert.match(
        matched.content[0].text,
        /case-insensitive literal substring matching/,
      );
      assert.equal(recall.details.warnings[0].id, "same-id");
      assert.equal(await readFile(file, "utf8"), bytes);
      const newRecord = (content: string) =>
        JSON.stringify({ id: "new-id", created: "2026-01-01", content });
      await writeFile(
        file,
        `${bytes}${newRecord("third")}\n${newRecord("fourth")}\n`,
      );
      await handlers.get("session_compact")!({}, ctx);
      await handlers.get("before_agent_start")!({}, ctx);
      assert.equal(warnings.length, 2);
      assert.match(warnings[1], /new-id/);
      await writeFile(file, `${record("first")}\n`);
      await handlers.get("session_compact")!({}, ctx);
      const result = await handlers.get("before_agent_start")!({}, ctx);
      assert.match(result.message.content, /first/);
      assert.equal(warnings.length, 2);
      await writeFile(file, `${newRecord("third")}\n${newRecord("fourth")}\n`);
      await handlers.get("session_compact")!({}, ctx);
      const next = await handlers.get("before_agent_start")!({}, ctx);
      assert.match(next.message.content, /third/);
      assert.equal(warnings.length, 3);
      assert.match(warnings[2], /new-id/);
      await handlers.get("session_shutdown")!({}, ctx);
    } finally {
      console.error = originalError;
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
