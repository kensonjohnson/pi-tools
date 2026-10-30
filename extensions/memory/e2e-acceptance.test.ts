import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MemoryManager } from "./core.ts";
import { MemoryReviewer } from "./reviewer.ts";
import { MemoryScheduler, reviewProjectSessions } from "./scheduler.ts";
import { SessionReview } from "./session-review.ts";
import extension from "./index.ts";

const user = (content: string) => ({
  role: "user" as const,
  content,
  timestamp: Date.now(),
});
function flush(sm: SessionManager) {
  sm.appendMessage({
    role: "assistant",
    content: [],
    api: "fake",
    provider: "fake",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as any);
}
async function waitFor(predicate: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test(
  "offline session-to-memory review preserves authority, isolation, recall and SDK injection",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-e2e-")),
      cwd = join(root, "project"),
      agentDir = join(root, "agent"),
      sessions = join(root, "sessions");
    const oldAgent = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const originalInitialize = MemoryManager.prototype.initialize;
    // SDK-created managers use a deterministic local FTS-only index, with no model downloads.
    MemoryManager.prototype.initialize = async function () {
      (this as any).options.semanticEnabled = false;
      (this as any).index.options.semanticEnabled = false;
      return originalInitialize.call(this);
    };
    const sdkSessions: Awaited<
      ReturnType<typeof createAgentSession>
    >["session"][] = [];
    const store = new MemoryManager(cwd, { semanticEnabled: false });
    let scheduler: MemoryScheduler | undefined;
    try {
      await mkdir(cwd);
      await mkdir(sessions);
      await store.init();
      await writeFile(
        join(cwd, ".pi", "pi-tools.json"),
        JSON.stringify({
          version: 1,
          extensions: { memory: { historyReview: { enabled: false } } },
        }),
      );
      await writeFile(
        join(cwd, "browser.txt"),
        "Browser backend: Playwright Chromium.\n\nBrowser tests: npm run test:browser.\n\nAuthentication backend: ephemeral profiles.\n",
      );
      const stale = (
        await store.remember("knowledge", "Browser uses Puppeteer.")
      ).memory;
      const protectedRule = (
        await store.remember(
          "knowledge",
          "Always keep authentication in named profiles.",
        )
      ).memory;
      const move = (
        await store.remember(
          "knowledge",
          "Browser tests run with npm run test:browser.",
        )
      ).memory;
      await store.remember("knowledge", "Cache is enabled.");
      const sm = SessionManager.create(cwd, sessions);
      const rootId = sm.appendMessage(user("Review the browser tooling."));
      flush(sm);
      sm.appendMessage(user("Abandoned branch: browser uses PhantomJS."));
      sm.branch(rootId);
      const instruction =
        "Please do not capture session secrets in the browser diagnostics.";
      const instructionId = sm.appendMessage(user(instruction));
      const conflictText = "Cache is not enabled.";
      const conflictId = sm.appendMessage(user(conflictText));
      flush(sm);
      const progress = join(root, "scheduler", "session-progress.json");
      const discovery = new SessionReview({
        project: cwd,
        sessionDir: sessions,
        checkpointFile: progress,
      });
      const initialBatch = discovery.discover().batches[0];
      assert.ok(initialBatch);
      assert.ok(initialBatch.items.some((x) => x.id === instructionId));
      assert.ok(!initialBatch.items.some((x) => x.text.includes("PhantomJS")));
      discovery.close();
      async function sdk() {
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          extensionFactories: [extension],
        });
        await loader.reload();
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd),
          settingsManager: SettingsManager.inMemory(),
          noTools: true,
        });
        sdkSessions.push(session);
        await session.bindExtensions({});
        return session;
      }
      const first = await sdk();
      const inject = async (session: typeof first) =>
        session.extensionRunner.emitBeforeAgentStart(
          "test",
          undefined,
          "system",
          { cwd },
        );
      const text = (result: Awaited<ReturnType<typeof inject>>) =>
        (result?.messages?.[0]?.content ?? "") as string;
      const originalBriefing = text(await inject(first));
      assert.match(originalBriefing, /Browser uses Puppeteer/);
      const initialBriefingBytes = Buffer.byteLength(originalBriefing);
      let phase: "changes" | "opposite" | "done" = "changes";
      let generated = 0;
      const model: any = {
        generate: async ({ instruction: prompt, data }: any) => {
          generated++;
          if (prompt.startsWith("Select")) return { paths: ["browser.txt"] };
          if (prompt.startsWith("Independently"))
            return {
              verdict: "supported",
              reason: "The complete source supports the candidate.",
            };
          const memories = data.memories as Array<{
            id: string;
            content: string;
            category: string;
          }>;
          const cite = (quote: string) => ({
            kind: "file",
            id: data.files[0].id,
            quote,
          });
          if (phase === "changes") {
            if (
              memories.some(
                (m) =>
                  m.id === stale.id && m.content === "Browser uses Puppeteer.",
              )
            )
              return {
                action: "update",
                id: stale.id,
                content: "Browser uses Playwright Chromium.",
                targetAuthority: "fact",
                citation: cite("Browser backend: Playwright Chromium."),
                reason: "Current browser implementation replaced Puppeteer.",
              };
            if (
              memories.some(
                (m) => m.id === move.id && m.category === "knowledge",
              )
            )
              return {
                action: "move",
                id: move.id,
                category: "practices",
                citation: cite("Browser tests: npm run test:browser."),
                reason: "This is a specialized test practice.",
              };
            if (
              !memories.some(
                (m) =>
                  m.content ===
                  "Do not capture session secrets in browser diagnostics.",
              )
            )
              return {
                action: "add",
                category: "practices",
                content:
                  "Do not capture session secrets in browser diagnostics.",
                citation: {
                  kind: "session",
                  id: instructionId,
                  quote: instruction,
                },
                reason: "The user explicitly instructed this practice.",
              };
            return {
              action: "update",
              id: protectedRule.id,
              content: "Authentication uses ephemeral profiles.",
              targetAuthority: "fact",
              citation: cite("Authentication backend: ephemeral profiles."),
              reason: "Code differs from the prior instruction.",
            };
          }
          if (phase === "opposite")
            return {
              action: "add",
              category: "knowledge",
              content: conflictText,
              citation: {
                kind: "session",
                id: conflictId,
                quote: conflictText,
              },
              reason: "User reported the opposite claim.",
            };
          return {
            action: "no_change",
            evidenceSufficient: true,
            reason: "Session evidence reviewed.",
          };
        },
      };
      const runtime = join(root, "scheduler");
      scheduler = new MemoryScheduler({
        project: cwd,
        runtimeDir: runtime,
        sessionDir: sessions,
        debounceMs: 0,
        cooldownMs: 0,
        retryMs: 5,
        work: async (dir, signal) =>
          reviewProjectSessions({
            project: cwd,
            sessionDir: dir,
            checkpointFile: progress,
            reviewer: new MemoryReviewer({ project: cwd, store, model }),
            signal,
          }),
      });
      await scheduler.activity();
      await waitFor(() => scheduler!.status().paused, "protected conflict");
      assert.equal(scheduler.status().status, "unresolved");
      const after = await store.list();
      assert.deepEqual(after.counts, {
        knowledge: 3,
        practices: 2,
        decisions: 0,
      });
      assert.equal(after.memories.filter((x) => x.id === move.id).length, 1);
      assert.equal(
        after.memories.find((x) => x.id === stale.id)?.content,
        "Browser uses Playwright Chromium.",
      );
      assert.equal(
        after.memories.find((x) => x.id === protectedRule.id)?.content,
        protectedRule.content,
      );
      assert.equal(
        after.memories.find((x) => x.id === move.id)?.category,
        "practices",
      );
      assert.ok(
        after.memories.some(
          (x) =>
            x.content ===
            "Do not capture session secrets in browser diagnostics.",
        ),
      );
      assert.ok(after.memories.every((x) => !x.content.includes("PhantomJS")));
      assert.ok(
        (
          await store.recall({
            query: "Playwright Chromium",
            category: "knowledge",
          })
        ).memories.some((x) => x.id === stale.id),
      );
      assert.ok(
        (
          await store.recall({ query: "browser test", category: "practices" })
        ).memories.some((x) => x.id === move.id),
      );
      assert.equal(await inject(first), undefined); // no replacement in an active session
      phase = "opposite";
      scheduler.resume();
      await waitFor(() => scheduler!.status().paused, "opposite claim");
      assert.ok(
        !(await store.list()).memories.some((x) => x.content === conflictText),
      );
      assert.ok(
        scheduler.report().events.some((x) => x.status === "unresolved"),
      );
      phase = "done";
      scheduler.resume();
      await waitFor(
        () => !scheduler!.status().pending && !scheduler!.status().inflight,
        "checkpoint",
      );
      assert.ok(generated > 0);
      const check = new SessionReview({
        project: cwd,
        sessionDir: sessions,
        checkpointFile: progress,
      });
      assert.equal(check.discover().batches.length, 0);
      check.close();
      await first.extensionRunner.emit({
        type: "session_compact",
        reason: "manual",
        fromExtension: false,
        willRetry: false,
        compactionEntry: {
          type: "compaction",
          id: "compact",
          parentId: null,
          timestamp: new Date().toISOString(),
          summary: "summary",
          firstKeptEntryId: "kept",
          tokensBefore: 1,
        },
      });
      const refreshed = text(await inject(first));
      // Measure briefing size separately; no fixed target substitutes for retention and recall.
      assert.ok(initialBriefingBytes > 0 && Buffer.byteLength(refreshed) > 0);
      assert.match(refreshed, /Browser uses Playwright Chromium/);
      assert.match(refreshed, /Always keep authentication/);
      assert.doesNotMatch(refreshed, /Puppeteer/);
      const second = await sdk();
      assert.match(
        text(await inject(second)),
        /Browser uses Playwright Chromium/,
      );
      await scheduler.shutdown();
      scheduler = undefined;
      const reopened = new MemoryManager(cwd, { semanticEnabled: false });
      try {
        assert.ok(
          (
            await reopened.recall({
              query: "Playwright",
              category: "knowledge",
            })
          ).memories.some((x) => x.id === stale.id),
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await scheduler?.shutdown();
      for (const session of sdkSessions) {
        try {
          await session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
        } catch {}
        session.dispose();
      }
      await store.close();
      MemoryManager.prototype.initialize = originalInitialize;
      if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgent;
      await rm(root, { recursive: true, force: true });
    }
  },
);
