import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTaskWorkstreamTools } from "./task-tools.ts";

type RegisteredTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  execute?: (...args: any[]) => Promise<any>;
  renderCall?: (
    args: any,
    theme: any,
    context: any,
  ) => {
    render(width: number): string[];
  };
  renderResult?: (
    result: any,
    options: any,
    theme: any,
    context: any,
  ) => {
    render(width: number): string[];
  };
};

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
};

test("task control exposes explicit resolution and refreshes the widget", async () => {
  const tools: RegisteredTool[] = [];
  const calls: unknown[] = [];
  let refreshes = 0;
  const service = {
    async control(_ctx: unknown, input: unknown) {
      calls.push(input);
      return {
        id: "task-to-resolve",
        status: "settled",
      };
    },
    async refreshWidget() {
      refreshes++;
    },
  };
  registerTaskWorkstreamTools(
    {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    } as ExtensionAPI,
    () => service as any,
  );

  const control = tools.find((tool) => tool.name === "subagent_task_control");
  assert.ok(control?.execute);
  assert.match(JSON.stringify((control as any).parameters), /resolve/);
  assert.match(control.description ?? "", /does not acknowledge or consume/);
  const input = {
    workstreamId: "task-to-resolve",
    action: "resolve",
    message: "Parent handled the worker decision.",
  };
  const result = await control.execute!(
    "resolve-1",
    input,
    undefined,
    undefined,
    {},
  );

  assert.deepEqual(calls, [input]);
  assert.equal(refreshes, 1);
  assert.match(
    result.content[0]?.text ?? "",
    /task-to-resolve: resolve recorded; status: settled/,
  );
  assert.equal(result.details.action, "resolve");
  assert.equal(result.details.status, "settled");
});

test("task launch keeps one bounded completion entry while preserving raw chaining details", async () => {
  const tools: RegisteredTool[] = [];
  const workstreamId = "12345678-1234-1234-1234-123456789abc";
  const service = {
    async launch() {
      return { id: workstreamId, status: "running" };
    },
    async refreshWidget() {},
  };
  registerTaskWorkstreamTools(
    {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    } as ExtensionAPI,
    () => service as any,
  );

  const launch = tools.find((tool) => tool.name === "subagent_task_launch");
  assert.ok(launch?.execute);
  assert.equal(launch?.renderCall, undefined);
  assert.ok(launch?.renderResult);
  const objective = `Implement a compact objective title ${"x".repeat(180)}`;
  const args = { objective, scope: "Only subagents." };
  const result = await launch.execute!(
    "launch-1",
    args,
    undefined,
    undefined,
    {},
  );

  assert.equal(result.details.workstreamId, workstreamId);
  assert.equal(result.details.status, "running");
  assert.match(result.content[0]?.text ?? "", new RegExp(workstreamId));
  assert.match(result.content[0]?.text ?? "", /running independently/);

  const context = { args };
  const rendered = launch.renderResult!(result, {}, plainTheme, context)
    .render(240)
    .join("\n");
  assert.match(rendered, /^Task: Implement a compact objective title/);
  assert.match(rendered.trimEnd(), /…$/);
  assert.doesNotMatch(rendered, new RegExp(workstreamId));
  assert.doesNotMatch(rendered, /running independently/);
});
