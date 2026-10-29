import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

async function cdp(url: string) {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map<
    number,
    { resolve(v: any): void; reject(e: Error): void }
  >();
  const events = new Map<string, (value: any) => void>();
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data));
    if (data.id) {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) p?.reject(new Error(data.error.message));
      else p?.resolve(data.result);
    } else events.get(data.method)?.(data.params);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("fixture CDP connection failed")),
      { once: true },
    );
  });
  return {
    send(method: string, params: object = {}) {
      const id = ++next;
      return new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    event(name: string) {
      return new Promise<any>((resolve) => events.set(name, resolve));
    },
    close() {
      ws.close();
    },
  };
}
const stillPending = (work: Promise<unknown>) =>
  Promise.race([
    work.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 150)),
  ]);

test(
  "page-scoped attachment leaves unrelated existing and new dialogs untouched",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "attachment-page-reg-")),
    );
    let hangArrived!: () => void;
    let hangCount = 0,
      timeoutCount = 0;
    const hanging = new Promise<void>((resolve) => {
      hangArrived = resolve;
    });
    const site = createServer((request, response) => {
      if (request.url === "/hang") {
        hangCount++;
        hangArrived();
        return;
      }
      if (request.url === "/hang2") {
        timeoutCount++;
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        request.url?.startsWith("/selected")
          ? `<title>selected</title><p>Page text</p><script>console.log('private-console');new Image().src='/asset?token=private'</script>`
          : "ok",
      );
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const child = spawn(
      chromium.executablePath(),
      [
        "--headless",
        "--no-sandbox",
        "--no-first-run",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${join(root, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
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
      on: (name: string, fn: Function) => handlers.set(name, fn),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        active = names;
      },
    };
    const sessions = new ManagedSessions({
      launch: async () => {
        throw new Error("unexpected browser launch");
      },
      attachmentLockRoot: join(root, "locks"),
    });
    const ctx = (owner = "owner") => ({
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => owner },
    });
    const call = async (args: any, owner = "owner", signal?: AbortSignal) =>
      tools
        .get("browser_attachment")
        .execute("id", args, signal, undefined, ctx(owner));
    let browser: Awaited<ReturnType<typeof cdp>> | undefined,
      other: Awaited<ReturnType<typeof cdp>> | undefined,
      added: Awaited<ReturnType<typeof cdp>> | undefined;
    try {
      const ws = await new Promise<string>((resolve, reject) => {
        let text = "";
        child.once("error", reject);
        child.once("exit", () => reject(new Error("fixture exited")));
        child.stderr.on("data", (chunk) => {
          text += chunk.toString();
          const match =
            /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(
              text,
            );
          if (match) resolve(match[1]);
        });
      });
      const endpoint = `http://${new URL(ws).host}`,
        pageEndpoint = (id: string) =>
          `ws://${new URL(ws).host}/devtools/page/${id}`;
      browser = await cdp(ws);
      const selected = (
        await browser.send("Target.createTarget", {
          url: "data:text/html,<title>before</title>",
        })
      ).targetId;
      const unrelated = (
        await browser.send("Target.createTarget", {
          url: "data:text/html,<title>unrelated</title>",
        })
      ).targetId;
      other = await cdp(pageEndpoint(unrelated));
      await other.send("Page.enable");
      const opened = other.event("Page.javascriptDialogOpening");
      const preexisting = other.send("Runtime.evaluate", {
        expression: "confirm('unrelated first')",
        returnByValue: true,
      });
      await opened;
      assert.equal(await stillPending(preexisting), true);
      createManagedBrowserExtension(pi as never, {
        loadSettings: async () => ({ values: {} }) as never,
        createSessions: () => sessions,
      });
      await handlers.get("session_start")!({}, ctx());
      await assert.rejects(
        call({ action: "connect", endpoint: "http://localhost:9222" }),
        /literal loopback/,
      );
      const attach = JSON.parse(
        (await call({ action: "connect", endpoint })).content[0].text,
      ).attachmentId;
      await assert.rejects(
        call({ action: "select", attachmentId: attach, targetId: selected }),
        /explicitly discovered/,
      );
      const list = JSON.parse(
        (await call({ action: "targets", attachmentId: attach })).content[0]
          .text,
      );
      assert.ok(list.targetIds.includes(selected));
      await assert.rejects(
        call(
          { action: "select", attachmentId: attach, targetId: selected },
          "foreign",
        ),
        /owned by another/,
      );
      await call({
        action: "select",
        attachmentId: attach,
        targetId: selected,
      });
      const rival = JSON.parse(
        (await call({ action: "connect", endpoint }, "other-owner")).content[0]
          .text,
      ).attachmentId;
      await call({ action: "targets", attachmentId: rival }, "other-owner");
      await assert.rejects(
        call(
          {
            action: "select",
            attachmentId: rival,
            targetId: selected,
            timeoutMs: 200,
          },
          "other-owner",
        ),
        /timed out|cancel|unresolved/i,
      );
      await assert.rejects(
        call({ action: "title", attachmentId: attach, targetId: unrelated }),
        /selected attachment target/,
      );
      await assert.rejects(
        tools
          .get("browser_screenshot")
          .execute(
            "id",
            { sessionId: attach, tabId: selected },
            undefined,
            undefined,
            ctx(),
          ),
        /unsupported for external/,
      );
      await assert.rejects(
        tools
          .get("browser_recording")
          .execute(
            "id",
            { action: "start_trace", sessionId: attach },
            undefined,
            undefined,
            ctx(),
          ),
        /unsupported for external/,
      );
      await call({
        action: "start_diagnostics",
        attachmentId: attach,
        targetId: selected,
      });
      const url = `http://127.0.0.1:${(site.address() as any).port}/selected?code=private`;
      await call({
        action: "navigate",
        attachmentId: attach,
        targetId: selected,
        url,
      });
      assert.equal(
        JSON.parse(
          (
            await call({
              action: "title",
              attachmentId: attach,
              targetId: selected,
            })
          ).content[0].text,
        ).title,
        "selected",
      );
      assert.match(
        JSON.stringify(
          JSON.parse(
            (
              await call({
                action: "inspect",
                attachmentId: attach,
                targetId: selected,
              })
            ).content[0].text,
          ),
        ),
        /Page text/,
      );
      assert.equal(await stillPending(preexisting), true);
      await other.send("Page.handleJavaScriptDialog", { accept: false });
      await preexisting;
      const newId = (
        await browser.send("Target.createTarget", {
          url: "data:text/html,<title>new</title>",
        })
      ).targetId;
      added = await cdp(pageEndpoint(newId));
      await added.send("Runtime.evaluate", {
        expression: `new Image().src='http://127.0.0.1:${(site.address() as any).port}/unrelated-private'`,
      });
      await added.send("Page.enable");
      const nextOpen = added.event("Page.javascriptDialogOpening");
      const nextDialog = added.send("Runtime.evaluate", {
        expression: "confirm('unrelated second')",
        returnByValue: true,
      });
      await nextOpen;
      assert.equal(await stillPending(nextDialog), true);
      const evidence = JSON.parse(
        (
          await call({
            action: "diagnostics",
            attachmentId: attach,
            targetId: selected,
          })
        ).content[0].text,
      );
      assert.ok(evidence.records.some((item: any) => item.kind === "console"));
      assert.doesNotMatch(
        JSON.stringify(evidence),
        /private-console|token=private|code=private|unrelated/,
      );
      const stopped = JSON.parse(
        (await call({ action: "disconnect", attachmentId: attach })).content[0]
          .text,
      );
      assert.equal(stopped.uncertain, false);
      assert.equal(await stillPending(nextDialog), true);
      await added.send("Page.handleJavaScriptDialog", { accept: false });
      await nextDialog;
      const abortedId = JSON.parse(
        (await call({ action: "connect", endpoint })).content[0].text,
      ).attachmentId;
      await call({ action: "targets", attachmentId: abortedId });
      await call({
        action: "select",
        attachmentId: abortedId,
        targetId: selected,
      });
      const abort = new AbortController();
      const pending = call(
        {
          action: "navigate",
          attachmentId: abortedId,
          targetId: selected,
          url: `http://127.0.0.1:${(site.address() as any).port}/hang`,
          timeoutMs: 5000,
        },
        "owner",
        abort.signal,
      );
      await hanging;
      await assert.rejects(
        call({ action: "title", attachmentId: abortedId, targetId: selected }),
        /busy/,
      );
      abort.abort();
      await assert.rejects(pending, /outcome may be uncertain.*quarantined/);
      assert.equal(hangCount, 1);
      await assert.rejects(
        call({ action: "title", attachmentId: abortedId, targetId: selected }),
        /unavailable/,
      );
      const retryId = JSON.parse(
        (await call({ action: "connect", endpoint })).content[0].text,
      ).attachmentId;
      await call({ action: "targets", attachmentId: retryId });
      await assert.rejects(
        call({
          action: "select",
          attachmentId: retryId,
          targetId: selected,
          timeoutMs: 200,
        }),
        /unresolved|timed out|cancel/i,
      );
      const timedId = JSON.parse(
        (await call({ action: "connect", endpoint })).content[0].text,
      ).attachmentId;
      await call({ action: "targets", attachmentId: timedId });
      await call({ action: "select", attachmentId: timedId, targetId: newId });
      await assert.rejects(
        call({
          action: "navigate",
          attachmentId: timedId,
          targetId: newId,
          url: `http://127.0.0.1:${(site.address() as any).port}/hang2`,
          timeoutMs: 1000,
        }),
        /uncertain.*quarantined/,
      );
      assert.equal(child.exitCode, null);
      assert.equal(timeoutCount, 1);
      const idleId = JSON.parse(
        (await call({ action: "connect", endpoint })).content[0].text,
      ).attachmentId;
      await call({ action: "targets", attachmentId: idleId });
      await call({
        action: "select",
        attachmentId: idleId,
        targetId: unrelated,
      });
      await handlers.get("session_shutdown")!({}, ctx());
      assert.equal(child.exitCode, null);
      const targets = await browser.send("Target.getTargets");
      assert.ok(
        targets.targetInfos.some((item: any) => item.targetId === selected),
      );
      assert.ok(
        targets.targetInfos.some((item: any) => item.targetId === unrelated),
      );
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx());
      other?.close();
      added?.close();
      browser?.close();
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
