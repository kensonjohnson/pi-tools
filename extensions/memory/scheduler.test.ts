import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import {
  MemoryScheduler,
  reviewProjectSessions,
  type SchedulerClock,
} from "./scheduler.ts";

class Clock implements SchedulerClock {
  value = 0;
  id = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  now() {
    return this.value;
  }
  setTimeout(fn: () => void, delay: number) {
    const id = ++this.id;
    this.timers.set(id, { at: this.value + delay, fn });
    return id;
  }
  clearTimeout(id: unknown) {
    this.timers.delete(id as number);
  }
  advance(ms: number) {
    this.value += ms;
    const ready = [...this.timers].filter(([, t]) => t.at <= this.value);
    for (const [id, timer] of ready) {
      if (this.timers.delete(id)) timer.fn();
    }
  }
}
async function fixture(
  fn: (root: string, runtime: string, sessions: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "memory-scheduler-"));
  const runtime = join(root, "runtime"),
    sessions = join(root, "sessions");
  await mkdir(sessions);
  try {
    await fn(root, runtime, sessions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("activity coalesces, respects cooldown, and stays project isolated", () =>
  fixture(async (root, runtime, sessions) => {
    const clock = new Clock();
    let runs = 0;
    const s = new MemoryScheduler({
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 10,
      cooldownMs: 100,
      retryMs: 1,
      clock,
      work: async () => {
        runs++;
        return { status: "done" };
      },
    });
    await s.activity();
    await s.activity();
    clock.advance(9);
    assert.equal(runs, 0);
    clock.advance(1);
    await s.waitForIdle();
    assert.equal(runs, 1);
    assert.equal(s.status().pending, 0);
    await s.activity();
    clock.advance(10);
    assert.equal(runs, 1);
    clock.advance(90);
    await s.waitForIdle();
    assert.equal(runs, 2);
    assert.throws(
      () =>
        new MemoryScheduler({
          project: join(root, "other"),
          runtimeDir: runtime,
          sessionDir: sessions,
          work: async () => ({ status: "done" }),
        }),
      /another project/,
    );
    await s.shutdown();
  }));

test("shared project claim prevents duplicate work while retaining new generations", () =>
  fixture(async (root, runtime, sessions) => {
    const clock = new Clock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const options = {
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 1,
      clock,
      work: async () => {
        runs++;
        await gate;
        return { status: "done" as const };
      },
    };
    const a = new MemoryScheduler(options),
      b = new MemoryScheduler(options);
    await a.activity();
    clock.advance(0);
    assert.equal(runs, 1);
    await b.activity();
    clock.advance(0);
    await b.waitForIdle();
    assert.equal(runs, 1);
    release();
    await a.waitForIdle();
    assert.equal(a.status().pending, 1);
    clock.advance(1);
    await b.waitForIdle();
    assert.equal(runs, 2);
    await a.shutdown();
    await b.shutdown();
  }));

test("another process cannot bypass a cooldown set after its timer was scheduled", () =>
  fixture(async (root, runtime, sessions) => {
    const clock = new Clock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const work = async () => {
      runs++;
      if (runs === 1) await gate;
      return { status: "done" as const };
    };
    const options = {
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 100,
      retryMs: 1,
      clock,
      work,
    };
    const a = new MemoryScheduler(options),
      b = new MemoryScheduler(options);
    await a.activity();
    clock.advance(0);
    await b.activity();
    clock.advance(0);
    await b.waitForIdle();
    release();
    await a.waitForIdle();
    clock.advance(1);
    await b.waitForIdle();
    assert.equal(runs, 1);
    clock.advance(99);
    await b.waitForIdle();
    assert.equal(runs, 2);
    await a.shutdown();
    await b.shutdown();
  }));

test("shutdown preserves pending work and explicit cancel requires resume", () =>
  fixture(async (root, runtime, sessions) => {
    const clock = new Clock();
    let started = 0;
    const a = new MemoryScheduler({
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 1,
      clock,
      work: async (_dir, signal) => {
        started++;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { status: "pending" };
      },
    });
    await a.activity();
    clock.advance(0);
    assert.equal(started, 1);
    await a.shutdown();
    let completed = 0;
    const b = new MemoryScheduler({
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 1,
      clock,
      work: async () => {
        completed++;
        return { status: "done" };
      },
    });
    b.start();
    clock.advance(0);
    await b.waitForIdle();
    assert.equal(completed, 1);
    await b.activity();
    b.cancel();
    clock.advance(100);
    assert.equal(completed, 1);
    assert.equal(b.status().paused, true);
    b.resume();
    clock.advance(0);
    await b.waitForIdle();
    assert.equal(completed, 2);
    await b.shutdown();
  }));

test("a claimant in another process excludes this scheduler until it exits", () =>
  fixture(async (root, runtime, sessions) => {
    const clock = new Clock();
    let runs = 0;
    const scheduler = new MemoryScheduler({
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 1,
      clock,
      work: async () => {
        runs++;
        return { status: "done" };
      },
    });
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const DB=require('better-sqlite3'); const db=new DB(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('ready'); setInterval(()=>{},1000);`,
        join(runtime, "scheduler-claim.sqlite"),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout!, "data");
      await scheduler.activity();
      clock.advance(0);
      await scheduler.waitForIdle();
      assert.equal(runs, 0);
      child.kill("SIGKILL");
      await once(child, "exit");
      clock.advance(1);
      await scheduler.waitForIdle();
      assert.equal(runs, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await scheduler.shutdown();
    }
  }));

test("killed project claimant is released but interrupted work requires explicit resolution", () =>
  fixture(async (root, runtime, sessions) => {
    const clock = new Clock();
    let runs = 0;
    const scheduler = new MemoryScheduler({
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 1,
      clock,
      work: async () => {
        runs++;
        return { status: "done" };
      },
    });
    await scheduler.activity();
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `const DB=require('better-sqlite3'); const state=new DB(process.argv[1]); const claim=new DB(process.argv[2]); claim.exec('BEGIN IMMEDIATE'); state.exec("UPDATE meta SET inflight=1,status='running' WHERE id=1"); process.kill(process.pid,'SIGKILL');`,
        join(runtime, "scheduler.sqlite"),
        join(runtime, "scheduler-claim.sqlite"),
      ],
      { cwd: process.cwd() },
    );
    assert.equal(child.signal, "SIGKILL");
    clock.advance(0);
    await scheduler.waitForIdle();
    assert.equal(runs, 0);
    assert.equal(scheduler.status().status, "interrupted-uncertain");
    assert.equal(scheduler.status().paused, true);
    scheduler.resume();
    clock.advance(0);
    await scheduler.waitForIdle();
    assert.equal(runs, 1);
    await scheduler.shutdown();
  }));

test("uncertain model outcome never retries automatically", () =>
  fixture(async (root, runtime, sessions) => {
    const clock = new Clock();
    let runs = 0;
    const scheduler = new MemoryScheduler({
      project: root,
      runtimeDir: runtime,
      sessionDir: sessions,
      debounceMs: 0,
      cooldownMs: 0,
      retryMs: 1,
      clock,
      work: async () => {
        runs++;
        return { status: "uncertain" };
      },
    });
    await scheduler.activity();
    clock.advance(0);
    await scheduler.waitForIdle();
    clock.advance(1000);
    assert.equal(runs, 1);
    assert.equal(scheduler.status().paused, true);
    assert.equal(scheduler.status().pending, 1);
    await scheduler.shutdown();
  }));

test("session discovery consumes snapshot-bound pages and only clears complete work", () =>
  fixture(async (root, runtime, sessions) => {
    const file = join(sessions, "one.jsonl");
    await writeFile(
      file,
      [
        { type: "session", version: 3, id: "s", cwd: root },
        {
          type: "message",
          id: "a",
          parentId: null,
          message: { role: "user", content: "hello" },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
    let calls = 0;
    const reviewer: any = {
      review: async ({ batch, fullOffset }: any) => {
        calls++;
        if (fullOffset === undefined)
          return {
            status: "unchanged",
            acknowledged: false,
            nextOffset: 50,
            fullSnapshot: "hash",
          };
        assert.equal(fullOffset, 50);
        batch.acknowledge();
        return { status: "unchanged", acknowledged: true };
      },
    };
    const result = await reviewProjectSessions({
      project: root,
      sessionDir: sessions,
      checkpointFile: join(runtime, "progress.json"),
      reviewer,
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "done");
    assert.equal(calls, 2);
    const db = new Database(join(runtime, "progress.json.lock.db"));
    db.close();
  }));
