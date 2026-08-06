import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: any) => unknown;

type FooterHarness = {
  handlers: Map<string, Handler>;
  footers: Array<(tui: any, theme: any, footerData: any) => any>;
  pi: ExtensionAPI;
};

function createHarness(): FooterHarness {
  const handlers = new Map<string, Handler>();
  const footers: Array<(tui: any, theme: any, footerData: any) => any> = [];

  return {
    handlers,
    footers,
    pi: {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI,
  };
}

function assistantMessage(output: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "stop",
    usage: {
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}

function context(
  cwd: string,
  hasUI: boolean,
  footers: FooterHarness["footers"],
  modelRegistryCalls: { count: number },
) {
  return {
    hasUI,
    cwd,
    isProjectTrusted: () => false,
    model: { id: "test-model", contextWindow: 1000 },
    modelRegistry: {
      async getApiKeyForProvider() {
        modelRegistryCalls.count += 1;
        return undefined;
      },
    },
    ui: {
      setFooter(footer: (tui: any, theme: any, footerData: any) => any) {
        footers.push(footer);
      },
    },
    getContextUsage: () => ({ contextWindow: 1000, tokens: 100, percent: 10 }),
    sessionManager: {
      getCwd: () => cwd,
      getSessionName: () => undefined,
    },
  };
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test("isolates footer lifecycle and TPS state from headless worker factories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-custom-footer-"));
  const agentDir = join(root, "agent");
  const configPath = join(agentDir, "pi-tools.json");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        extensions: {
          "custom-stats-footer": { codexQuota: { enabled: true } },
        },
      }),
      "utf8",
    );
    const { default: extension } = await import("../custom-stats-footer.ts");
    const main = createHarness();
    const worker = createHarness();
    extension(main.pi);
    extension(worker.pi);

    const workerRegistryCalls = { count: 0 };
    const workerCtx = context(root, false, worker.footers, workerRegistryCalls);
    await worker.handlers.get("session_start")?.({}, workerCtx);
    await worker.handlers.get("message_start")?.(
      { message: assistantMessage(1_000_000) },
      workerCtx,
    );
    await worker.handlers.get("message_end")?.(
      { message: assistantMessage(1_000_000) },
      workerCtx,
    );
    await worker.handlers.get("agent_start")?.({}, workerCtx);

    assert.equal(worker.footers.length, 0);
    assert.equal(workerRegistryCalls.count, 0);

    await rm(configPath);
    const mainRegistryCalls = { count: 0 };
    const mainCtx = context(root, true, main.footers, mainRegistryCalls);
    await main.handlers.get("session_start")?.({}, mainCtx);
    assert.equal(main.footers.length, 1);

    await main.handlers.get("message_start")?.(
      { message: assistantMessage(20) },
      mainCtx,
    );
    await sleep(30);
    await worker.handlers.get("message_start")?.(
      { message: assistantMessage(1_000_000) },
      workerCtx,
    );
    await sleep(20);
    await worker.handlers.get("message_end")?.(
      { message: assistantMessage(1_000_000) },
      workerCtx,
    );
    await sleep(30);
    await main.handlers.get("message_end")?.(
      { message: assistantMessage(20) },
      mainCtx,
    );

    const footer = main.footers[0]!(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text },
      {
        onBranchChange: () => () => {},
        getGitBranch: () => undefined,
        getExtensionStatuses: () => new Map(),
      },
    );
    const tps = Number(
      footer
        .render(120)
        .join("\n")
        .match(/(\d+) response tps/)?.[1],
    );
    assert.ok(tps > 0 && tps < 1_000, `unexpected main TPS: ${tps}`);

    await main.handlers.get("agent_start")?.({}, mainCtx);
    assert.equal(main.footers.length, 2);
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
