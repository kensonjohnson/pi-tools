import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AttachmentLeases } from "./attachment-leases.ts";

function fixture() {
  let gate: Promise<void> = Promise.resolve();
  const page = Object.assign(new EventEmitter(), { isClosed: () => false });
  const context = {
    pages: () => [page],
    newCDPSession: async () => ({
      send: async () => {
        await gate;
        return { targetInfo: { type: "page", targetId: "target" } };
      },
      detach: async () => {},
    }),
  };
  const browser = Object.assign(new EventEmitter(), {
    contexts: () => [context],
  });
  return {
    page,
    connection: { browser, disconnect() {} } as any,
    setGate(value: Promise<void>) {
      gate = value;
    },
  };
}
async function root() {
  return mkdtemp(join(tmpdir(), "attachment-locks-"));
}

test("distinct aliases cannot lease the same target", async () => {
  const dir = await root();
  const f = fixture();
  const a = new AttachmentLeases(f.connection, "http://127.0.0.1:22222", {
    lockRoot: dir,
  });
  const b = new AttachmentLeases(f.connection, "http://[::1]:22222", {
    lockRoot: dir,
  });
  try {
    assert.deepEqual(await a.targets("one"), ["target"]);
    await a.select("one", "target");
    assert.equal(await a.withPage("one", async (page) => page), f.page);
    await assert.rejects(a.withPage("two", async (page) => page));
    await assert.rejects(
      b.select("two", "target", { timeoutMs: 120 }),
      /timed out|cancel/i,
    );
  } finally {
    await a.disconnect();
    await b.disconnect();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "a lease is exclusive across OS processes and aliases",
  { timeout: 10000 },
  async () => {
    const dir = await root();
    const f = fixture();
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        new URL("./attachment-lease-helper.mjs", import.meta.url).pathname,
        dir,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const a = new AttachmentLeases(f.connection, "http://127.0.0.1:22222", {
      lockRoot: dir,
    });
    try {
      const [chunk] = await once(child.stdout, "data");
      assert.match(chunk.toString(), /ready/);
      await assert.rejects(
        a.select("owner", "target", { timeoutMs: 150 }),
        /timed out|cancel/i,
      );
      child.stdin.write("done\n");
      await once(child, "exit");
      const b = new AttachmentLeases(f.connection, "http://127.0.0.1:22222", {
        lockRoot: dir,
      });
      await b.select("owner", "target");
      await b.disconnect();
    } finally {
      await a.disconnect();
      child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("stalled enumeration aborts promptly and never acquires late", async () => {
  const dir = await root();
  const f = fixture();
  let release!: () => void;
  f.setGate(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const a = new AttachmentLeases(f.connection, "http://127.0.0.1:22223", {
    lockRoot: dir,
  });
  const controller = new AbortController();
  const pending = a.targets("one", { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /cancel/i);
  release();
  await a.disconnect();
  await rm(dir, { recursive: true, force: true });
});

test("timed-out active work quarantines its lock even after the callback settles", async () => {
  const dir = await root();
  const f = fixture();
  const a = new AttachmentLeases(f.connection, "http://127.0.0.1:22224", {
    lockRoot: dir,
  });
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  try {
    await a.select("one", "target");
    await assert.rejects(
      a.withPage(
        "one",
        async () => {
          await gate;
        },
        { timeoutMs: 30 },
      ),
      /uncertain/i,
    );
    assert.equal((await a.disconnect()).pending, 1);
    const b = new AttachmentLeases(f.connection, "http://[::1]:22224", {
      lockRoot: dir,
    });
    await assert.rejects(
      b.select("two", "target", { timeoutMs: 130 }),
      /timed out|cancel/i,
    );
    finish();
    const c = new AttachmentLeases(f.connection, "http://[::1]:22224", {
      lockRoot: dir,
    });
    await assert.rejects(
      c.select("two", "target", { timeoutMs: 130 }),
      /timed out|cancel|unresolved/i,
    );
    assert.equal((await a.disconnect()).uncertain, 1);
    await c.disconnect();
    await b.disconnect();
  } finally {
    finish();
    await a.disconnect();
    await rm(dir, { recursive: true, force: true });
  }
});
