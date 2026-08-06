import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTaskWorkstreamTools } from "./task-tools.ts";

type RegisteredTool = {
  name: string;
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

test("task launch renders its bounded objective while preserving raw chaining details", async () => {
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
  assert.ok(launch?.renderCall);
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
  const call = launch.renderCall!(args, plainTheme, context)
    .render(240)
    .join("\n");
  const rendered = launch.renderResult!(result, {}, plainTheme, context)
    .render(240)
    .join("\n");
  assert.match(call, /^Task: Implement a compact objective title/);
  assert.match(rendered, /^Task: Implement a compact objective title/);
  assert.match(rendered.trimEnd(), /…$/);
  assert.doesNotMatch(rendered, new RegExp(workstreamId));
  assert.doesNotMatch(rendered, /running independently/);
});
