import assert from "node:assert/strict";
import test from "node:test";
import { parsePiToolsCommand } from "./pi-tools-command.ts";

function command(args: string) {
  const result = parsePiToolsCommand(args);
  assert.ok("command" in result, "expected a parsed command");
  return result.command;
}

test("parses interactive, status, and path commands", () => {
  assert.deepEqual(command(""), { action: "open", scope: undefined });
  assert.deepEqual(command("--project"), { action: "open", scope: "project" });
  assert.deepEqual(command("status"), { action: "status" });
  assert.deepEqual(command("paths"), { action: "paths" });
});

test("parses scoped get, set, enable, and disable commands", () => {
  assert.deepEqual(command("get custom-stats-footer.codexQuota.enabled"), {
    action: "get",
    address: {
      extensionId: "custom-stats-footer",
      field: "codexQuota.enabled",
    },
  });
  assert.deepEqual(
    command('--project set custom-stats-footer.label "weekly quota"'),
    {
      action: "set",
      scope: "project",
      address: {
        extensionId: "custom-stats-footer",
        field: "label",
      },
      input: "weekly quota",
    },
  );
  assert.deepEqual(command("enable memory --global"), {
    action: "enable",
    scope: "global",
    extensionId: "memory",
  });
  assert.deepEqual(command("--project disable browser-tools"), {
    action: "disable",
    scope: "project",
    extensionId: "browser-tools",
  });
  assert.deepEqual(command("set alpha.label -- --project"), {
    action: "set",
    scope: undefined,
    address: { extensionId: "alpha", field: "label" },
    input: "--project",
  });
  assert.deepEqual(command('set alpha.label ""'), {
    action: "set",
    scope: undefined,
    address: { extensionId: "alpha", field: "label" },
    input: "",
  });
});

test("reports invalid command syntax", () => {
  for (const args of [
    "--global --project status",
    "set memory.enabled",
    "get memory",
    "enable memory extra",
    "--project paths",
    "set memory.enabled 'unclosed",
  ]) {
    const result = parsePiToolsCommand(args);
    assert.ok("error" in result, `expected an error for ${args}`);
  }
});
