import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentLeases } from "./attachment-leases.ts";

test(
  "crashed attachment leaves a durable fail-closed ownership marker",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "attachment-crash-"));
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        new URL("./attachment-lease-helper.mjs", import.meta.url).pathname,
        dir,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const page = Object.assign(new EventEmitter(), { isClosed: () => false });
    const context = {
      pages: () => [page],
      newCDPSession: async () => ({
        send: async () => ({
          targetInfo: { type: "page", targetId: "target" },
        }),
        detach: async () => {},
      }),
    };
    const browser = Object.assign(new EventEmitter(), {
      contexts: () => [context],
    });
    const lease = new AttachmentLeases(
      { browser, disconnect() {} } as any,
      "http://127.0.0.1:22222",
      { lockRoot: dir },
    );
    try {
      await once(child.stdout, "data");
      child.kill("SIGKILL");
      await once(child, "exit");
      await assert.rejects(
        lease.select("owner", "target"),
        /ownership is unresolved/i,
      );
    } finally {
      child.kill();
      await lease.disconnect();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
