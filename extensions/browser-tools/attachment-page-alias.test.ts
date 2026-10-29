import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSessions } from "./sessions.ts";
import { createManagedBrowserExtension } from "./registration.ts";

async function endpoint(host: "127.0.0.1" | "::1") {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/version")
      response.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://${request.headers.host}/devtools/browser/fake`,
        }),
      );
    else if (request.url === "/json/list")
      response.end(JSON.stringify([{ id: "shared-target", type: "page" }]));
    else {
      response.writeHead(404);
      response.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(
        String(request.headers["sec-websocket-key"]) +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const origin = `http://${host === "::1" ? "[::1]" : host}:${(server.address() as any).port}`;
  return {
    origin,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test(
  "page leases contend across loopback aliases and OS processes",
  { timeout: 15000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "attachment-alias-")),
    );
    const ipv4 = await endpoint("127.0.0.1"),
      ipv6 = await endpoint("::1");
    const sessions = new ManagedSessions({
      launch: async () => {
        throw new Error("unexpected");
      },
      attachmentLockRoot: root,
    });
    try {
      const a = await sessions.attachExternal(ipv4.origin, "one");
      const b = await sessions.attachExternal(ipv6.origin, "two");
      assert.deepEqual(
        (await sessions.attachmentTargets(a.attachmentId, "one")).targetIds,
        ["shared-target"],
      );
      assert.deepEqual(
        (await sessions.attachmentTargets(b.attachmentId, "two")).targetIds,
        ["shared-target"],
      );
      await sessions.selectAttachment(a.attachmentId, "one", "shared-target");
      await assert.rejects(
        sessions.selectAttachment(
          b.attachmentId,
          "two",
          "shared-target",
          undefined,
          200,
        ),
        /timed out|cancel|unresolved/i,
      );
      const source = `import { AttachedPage } from ${JSON.stringify(new URL("./attachment-page.ts", import.meta.url).href)}; import { discoverAttachmentEndpoint } from ${JSON.stringify(new URL("./attachment-endpoint.ts", import.meta.url).href)}; await discoverAttachmentEndpoint(${JSON.stringify(ipv6.origin)}); try { const page = await AttachedPage.connect(${JSON.stringify(ipv6.origin)}, "shared-target", {lockRoot:${JSON.stringify(root)},timeoutMs:200}); await page.disconnect(); process.exit(1); } catch (e) { process.exit(/timed out|cancel|unresolved/i.test(String(e)) ? 0 : 2); }`;
      const contender = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", source],
        { stdio: "ignore" },
      );
      const [code] = await once(contender, "exit");
      assert.equal(code, 0);
      assert.equal(
        (await sessions.disconnectAttachment(a.attachmentId, "one")).uncertain,
        false,
      );
      const c = await sessions.attachExternal(ipv6.origin, "two");
      await sessions.attachmentTargets(c.attachmentId, "two");
      await sessions.selectAttachment(c.attachmentId, "two", "shared-target");
      assert.equal(
        (await sessions.disconnectAttachment(c.attachmentId, "two")).uncertain,
        false,
      );
    } finally {
      await sessions.shutdown();
      await ipv4.close();
      await ipv6.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "crashed target lease remains quarantined without exposing its private path at the tool boundary",
  { timeout: 15000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "private-attachment-crash-")),
    );
    const local = await endpoint("127.0.0.1");
    const sessions = new ManagedSessions({
      launch: async () => {
        throw new Error("unexpected");
      },
      attachmentLockRoot: root,
    });
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
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "owner" },
    };
    const call = (args: object) =>
      tools
        .get("browser_attachment")
        .execute("id", args, undefined, undefined, ctx);
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      const source = `import { acquireProfile } from ${JSON.stringify(new URL("./profiles.ts", import.meta.url).href)}; import { createHash } from 'node:crypto'; const name = 'attachment-' + createHash('sha256').update('shared-target').digest('hex').slice(0,48); await acquireProfile(name, {root:${JSON.stringify(root)}}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
      holder = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", source],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await Promise.race([
        once(holder.stdout!, "data"),
        once(holder, "exit").then(() => {
          throw new Error("lease holder exited before readiness");
        }),
      ]);
      holder.kill("SIGKILL");
      await once(holder, "exit");
      const markers = (await readdir(root)).filter((name) =>
        name.endsWith(".pending"),
      );
      assert.equal(markers.length, 1);
      createManagedBrowserExtension(pi as never, {
        loadSettings: async () => ({ values: {} }) as never,
        createSessions: () => sessions,
      });
      await handlers.get("session_start")!({}, ctx);
      for (let i = 0; i < 2; i++) {
        const attachmentId = JSON.parse(
          (await call({ action: "connect", endpoint: local.origin })).content[0]
            .text,
        ).attachmentId;
        await call({ action: "targets", attachmentId });
        await assert.rejects(
          call({
            action: "select",
            attachmentId,
            targetId: "shared-target",
            timeoutMs: 1000,
          }),
          (error: Error) => {
            assert.match(
              error.message,
              /ownership is unresolved.*quarantined/i,
            );
            assert.match(
              error.message,
              /verify no agent operation.*manual marker recovery/i,
            );
            assert.match(
              error.message,
              /never blindly signal PIDs or close the external browser/i,
            );
            assert.doesNotMatch(
              JSON.stringify(error, Object.getOwnPropertyNames(error)),
              new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
            );
            assert.ok(!error.message.includes(markers[0]));
            return true;
          },
        );
        assert.ok((await readdir(root)).includes(markers[0]));
      }
      const original = sessions.selectAttachment.bind(sessions);
      for (const internal of [
        `Profile lease wait timed out; inspect ${root}/marker`,
        `Unsafe profile lock metadata: ${root}/unexpected`,
      ]) {
        sessions.selectAttachment = async () => {
          throw new Error(internal);
        };
        await assert.rejects(
          call({
            action: "select",
            attachmentId: "unused",
            targetId: "shared-target",
          }),
          (error: Error) => {
            assert.match(error.message, /failed or timed out.*quarantined/);
            assert.match(error.message, /manual marker recovery/);
            assert.ok(
              !JSON.stringify(
                error,
                Object.getOwnPropertyNames(error),
              ).includes(root),
            );
            return true;
          },
        );
      }
      sessions.selectAttachment = original;
    } finally {
      if (holder && holder.exitCode === null && holder.signalCode === null) {
        holder.kill("SIGKILL");
        await once(holder, "exit");
      }
      await handlers.get("session_shutdown")?.({}, ctx);
      await sessions.shutdown();
      await local.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "failed lease release is reported without leaking its marker path",
  { timeout: 15000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "private-attachment-release-")),
    );
    const local = await endpoint("127.0.0.1");
    const sessions = new ManagedSessions({
      launch: async () => {
        throw new Error("unexpected");
      },
      attachmentLockRoot: root,
    });
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
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "owner" },
    };
    const call = (args: object) =>
      tools
        .get("browser_attachment")
        .execute("id", args, undefined, undefined, ctx);
    try {
      createManagedBrowserExtension(pi as never, {
        loadSettings: async () => ({ values: {} }) as never,
        createSessions: () => sessions,
      });
      await handlers.get("session_start")!({}, ctx);
      const attachmentId = JSON.parse(
        (await call({ action: "connect", endpoint: local.origin })).content[0]
          .text,
      ).attachmentId;
      await call({ action: "targets", attachmentId });
      await call({ action: "select", attachmentId, targetId: "shared-target" });
      const marker = (await readdir(root)).find((name) =>
        name.endsWith(".pending"),
      );
      assert.ok(marker);
      await unlink(join(root, marker));
      await assert.rejects(
        call({ action: "disconnect", attachmentId }),
        (error: Error) => {
          assert.match(
            error.message,
            /cleanup could not be verified.*quarantined/,
          );
          assert.match(error.message, /manual marker recovery/);
          assert.ok(
            !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(
              root,
            ),
          );
          assert.ok(!error.message.includes(marker));
          return true;
        },
      );
      assert.equal((await sessions.shutdown()).complete, false);
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      await sessions.shutdown();
      await local.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
