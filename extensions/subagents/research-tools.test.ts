import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerResearchWorkstreamTools } from "./research-tools.ts";

type RegisteredTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  execute?: (...args: any[]) => Promise<any>;
};

test("research control exposes explicit resolution and refreshes the widget", async () => {
  const tools: RegisteredTool[] = [];
  const calls: unknown[] = [];
  let refreshes = 0;
  const service = {
    async control(_ctx: unknown, input: unknown) {
      calls.push(input);
      return {
        id: "research-to-resolve",
        status: "settled",
      };
    },
    async refreshWidget() {
      refreshes++;
    },
  };
  registerResearchWorkstreamTools(
    {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    } as ExtensionAPI,
    () => service as any,
  );

  const control = tools.find(
    (tool) => tool.name === "subagent_research_control",
  );
  assert.ok(control?.execute);
  assert.match(JSON.stringify(control.parameters), /resolve/);
  assert.match(control.description ?? "", /without acknowledging or consuming/);
  const input = {
    workstreamId: "research-to-resolve",
    action: "resolve",
    message: "Parent handled the research blocker.",
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
    /research-to-resolve: resolve recorded; status: settled/,
  );
  assert.equal(result.details.action, "resolve");
  assert.equal(result.details.status, "settled");
});
