import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  readFile,
  stat,
  symlink,
  link,
  writeFile,
  mkdir,
  readdir,
  lstat,
  rmdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "./artifacts.ts";
import { chunkOutput, inspectionOutput } from "./output.ts";

async function fixture() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "browser-artifacts-")),
  );
  return { parent, root: join(parent, "managed") };
}
test("large one-line Unicode results reconstruct exactly and stay bounded", async () => {
  const { parent, root } = await fixture();
  try {
    const store = new ArtifactStore({ root });
    const original = "\ufeff<p>" + 'é🙂"\\\n\ufeff'.repeat(220000) + "</p>";
    const result = JSON.parse(
      await inspectionOutput(store, "owner", original, { scope: "main" }),
    );
    assert.equal(result.complete, false);
    assert.match(result.notice, /Preview only/);
    assert.equal(result.previewBytes, Buffer.byteLength(result.preview));
    assert.ok(original.startsWith(result.preview));
    assert.equal(result.bytes, Buffer.byteLength(original));
    assert.equal((await stat(result.artifact.path)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    let offset = 0,
      reconstructed = "";
    for (;;) {
      const rendered = await chunkOutput(
        store,
        "owner",
        result.artifact.id,
        offset,
        65536,
      );
      assert.ok(Buffer.byteLength(rendered) <= 48 * 1024);
      const chunk = JSON.parse(rendered);
      assert.equal(chunk.offset, offset);
      assert.equal(chunk.bytes, result.bytes);
      assert.equal(chunk.chunkBytes, Buffer.byteLength(chunk.text));
      reconstructed += chunk.text;
      if (chunk.nextOffset === null) break;
      assert.ok(chunk.nextOffset > offset);
      offset = chunk.nextOffset;
    }
    assert.equal(reconstructed, original);
    await assert.rejects(
      store.read("other", result.artifact.id),
      /unavailable/,
    );
    await assert.rejects(
      store.read("owner", "../escape"),
      /Invalid artifact ID/,
    );
    await assert.rejects(
      store.read("owner", result.artifact.id, 1),
      /boundary/,
    );
    await assert.rejects(store.put("owner", "\ud800"), /unpaired/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("quota is serialized, expired artifacts are removed, exports survive cleanup and never overwrite", async () => {
  const { parent, root } = await fixture();
  try {
    let now = 1700000000000;
    const a = new ArtifactStore({ root, quota: 100, ttl: 100, now: () => now });
    const b = new ArtifactStore({ root, quota: 100, ttl: 100, now: () => now });
    const results = await Promise.allSettled([
      a.put("a", "x".repeat(60)),
      b.put("b", "y".repeat(60)),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.match(
      String(
        (results.find((x) => x.status === "rejected") as PromiseRejectedResult)
          .reason,
      ),
      /quota/,
    );
    const stored = (
      results.find(
        (x) => x.status === "fulfilled",
      ) as PromiseFulfilledResult<any>
    ).value;
    const owner = results[0].status === "fulfilled" ? "a" : "b";
    const dest = join(parent, "export.txt");
    await a.export(owner, stored.id, dest);
    assert.equal((await stat(dest)).mode & 0o777, 0o600);
    await assert.rejects(a.export(owner, stored.id, dest), /EEXIST/);
    assert.equal((await readFile(dest, "utf8")).length, 60);
    now += 101;
    await assert.rejects(a.read(owner, stored.id), /expired/);
    assert.equal((await a.cleanup()).count, 0);
    assert.equal((await readFile(dest, "utf8")).length, 60);
    await b.put("b", "z".repeat(100));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("export reports publication when staging unlink fails or directory sync fails", async () => {
  const { parent, root } = await fixture();
  try {
    const baseline = new ArtifactStore({ root });
    const item = await baseline.put("owner", "export secret");
    const destination = join(parent, "export-once");
    let failures = 0;
    const injected = new ArtifactStore({
      root,
      publication: {
        unlink: (async (path: string) => {
          if (path.includes("/.browser-export-") && failures++ === 0)
            throw Object.assign(new Error("unlink fault"), { code: "EIO" });
          return unlink(path);
        }) as typeof unlink,
      },
    });
    const result = await injected.export("owner", item.id, destination);
    assert.equal(result.published, true);
    assert.equal(result.cleanup, "unverified");
    assert.equal(result.durability, "synced");
    assert.equal(await readFile(destination, "utf8"), "export secret");
    assert.equal(await readFile(result.stagingPath!, "utf8"), "export secret");
    assert.equal((await stat(result.stagingPath!)).mode & 0o777, 0o600);
    assert.match(result.notice!, /already exists/);
    await assert.rejects(
      injected.export("owner", item.id, destination),
      /EEXIST/,
    );
    assert.equal(await readFile(destination, "utf8"), "export secret");
    await unlink(result.stagingPath!);

    const persistent = new ArtifactStore({
      root,
      publication: {
        unlink: (async (path: string) => {
          if (path.includes("/.browser-export-"))
            throw new Error("persistent fault");
          return unlink(path);
        }) as typeof unlink,
      },
    });
    const second = await persistent.export(
      "owner",
      item.id,
      join(parent, "export-persistent"),
    );
    assert.equal(second.published, true);
    assert.equal(second.cleanup, "unverified");
    assert.equal(await readFile(second.stagingPath!, "utf8"), "export secret");
    assert.equal(await readFile(second.path, "utf8"), "export secret");
    assert.equal((await baseline.cleanup()).count, 1);
    await unlink(second.stagingPath!);

    let syncCalls = 0;
    const syncFault = new ArtifactStore({
      root,
      syncDirectory: async (path) => {
        assert.equal(path, parent);
        syncCalls++;
        throw new Error("sync fault");
      },
    });
    const third = await syncFault.export(
      "owner",
      item.id,
      join(parent, "export-sync"),
    );
    assert.equal(syncCalls, 1);
    assert.equal(third.published, true);
    assert.equal(third.cleanup, "complete");
    assert.equal(third.durability, "unverified");
    assert.equal(await readFile(third.path, "utf8"), "export secret");
    assert.equal(third.stagingPath, undefined);

    const prior = await readdir(parent);
    const prepublish = new ArtifactStore({
      root,
      publication: {
        link: (async () => {
          throw new Error("link fault");
        }) as typeof link,
        unlink: (async () => {
          throw new Error("cleanup fault");
        }) as typeof unlink,
      },
    });
    const missing = join(parent, "export-not-published");
    await assert.rejects(
      prepublish.export("owner", item.id, missing),
      /not published; staging cleanup.*Inspect it manually/,
    );
    await assert.rejects(stat(missing), /ENOENT/);
    const left = (await readdir(parent)).filter(
      (name) => !prior.includes(name),
    );
    assert.equal(left.length, 1);
    assert.match(left[0], /^\.browser-export-/);
    assert.equal(
      await readFile(join(parent, left[0]), "utf8"),
      "export secret",
    );
    await unlink(join(parent, left[0]));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("lock release faults preserve put, export, and bounded read results with recovery guidance", async () => {
  const { parent, root } = await fixture();
  try {
    const failRelease = (async () => {
      throw Object.assign(new Error("release fault"), { code: "EIO" });
    }) as typeof rmdir;
    const store = new ArtifactStore({ root, releaseLock: failRelease });
    const text = '"'.repeat(100000);
    const response = JSON.parse(
      await inspectionOutput(store, "owner", text, { scope: "main" }),
    );
    assert.equal(response.complete, false);
    assert.match(response.artifact.lockWarning, /operation completed.*manual/i);
    assert.match(response.notice, /lock cleanup failed/);
    assert.equal(await readFile(response.artifact.path, "utf8"), text);
    assert.ok((await readdir(root)).includes(".lock"));
    await rmdir(join(root, ".lock"));

    const chunkText = await chunkOutput(
      store,
      "owner",
      response.artifact.id,
      0,
      65536,
    );
    assert.ok(Buffer.byteLength(chunkText) <= 48 * 1024);
    const chunk = JSON.parse(chunkText);
    assert.match(chunk.lockWarning, /operation completed/);
    assert.equal(chunk.text, text.slice(0, chunk.chunkBytes));
    assert.equal(chunk.nextOffset, chunk.chunkBytes);
    await rmdir(join(root, ".lock"));

    const dest = join(parent, "saved");
    const exported = await store.export("owner", response.artifact.id, dest);
    assert.equal(exported.published, true);
    assert.equal(exported.path, dest);
    assert.match(exported.lockWarning!, /operation completed.*manual/i);
    assert.equal(await readFile(dest, "utf8"), text);
    assert.ok((await readdir(root)).includes(".lock"));
    await rmdir(join(root, ".lock"));
    const normal = new ArtifactStore({ root });
    assert.equal(
      (await normal.read("owner", response.artifact.id)).bytes,
      text.length,
    );
    assert.equal(await readFile(dest, "utf8"), text);

    await assert.rejects(
      store.export("owner", response.artifact.id, dest),
      /EEXIST.*Lock cleanup also failed/s,
    );
    assert.equal(await readFile(dest, "utf8"), text);
    await rmdir(join(root, ".lock"));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("publication sync failures sync rollback or retain the lock if durability is uncertain", async () => {
  const { parent, root } = await fixture();
  try {
    let calls = 0;
    const once = new ArtifactStore({
      root,
      syncDirectory: async (path) => {
        assert.equal(path, root);
        if (++calls === 1) throw new Error("sync fault");
      },
    });
    await assert.rejects(once.put("owner", "data"), /sync fault/);
    assert.equal(calls, 2);
    assert.deepEqual(await readdir(root), []);
    assert.equal((await once.put("owner", "next")).bytes, 4);
    const failedRoot = join(parent, "failed-sync");
    let persistentCalls = 0;
    const persistent = new ArtifactStore({
      root: failedRoot,
      syncDirectory: async () => {
        persistentCalls++;
        throw new Error("sync fault");
      },
    });
    await assert.rejects(persistent.put("owner", "data"), /lock is retained/);
    assert.equal(persistentCalls, 2);
    assert.deepEqual(await readdir(failedRoot), [".lock"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("lock disappearance after EEXIST retries and concurrent cleanup does not leak ENOENT", async () => {
  const { parent, root } = await fixture();
  try {
    const normal = new ArtifactStore({ root });
    await normal.cleanup();
    await mkdir(join(root, ".lock"));
    let calls = 0;
    const raced = new ArtifactStore({
      root,
      lockStat: (async (path: string) => {
        calls++;
        await rmdir(path);
        return lstat(path);
      }) as typeof lstat,
    });
    await raced.cleanup();
    assert.equal(calls, 1);
    for (let i = 0; i < 10; i++)
      await Promise.all(Array.from({ length: 20 }, () => normal.cleanup()));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("publication failures roll back only created names and retain the lock if recovery is uncertain", async () => {
  const { parent, root } = await fixture();
  try {
    const outside = join(parent, "outside");
    await writeFile(outside, "untouched");
    let failed = false;
    const retryable = new ArtifactStore({
      root,
      publication: {
        unlink: (async (path: string) => {
          if (!failed && path.includes("/.tmp-")) {
            failed = true;
            throw Object.assign(new Error("injected unlink failure"), {
              code: "EIO",
            });
          }
          return unlink(path);
        }) as typeof unlink,
      },
    });
    await assert.rejects(
      retryable.put("owner", "secret"),
      /injected unlink failure/,
    );
    assert.deepEqual(await readdir(root), []);
    assert.equal(await readFile(outside, "utf8"), "untouched");
    assert.equal((await retryable.put("owner", "success")).bytes, 7);

    const collidingRoot = join(parent, "collision");
    let collision = "";
    const colliding = new ArtifactStore({
      root: collidingRoot,
      publication: {
        link: (async (source: string, destination: string) => {
          collision = destination;
          await writeFile(destination, "existing", { mode: 0o600, flag: "wx" });
          return link(source, destination);
        }) as typeof link,
      },
    });
    await assert.rejects(colliding.put("owner", "new"), /EEXIST/);
    assert.equal(await readFile(collision, "utf8"), "existing");
    assert.equal((await colliding.cleanup()).count, 1);

    const swappedRoot = join(parent, "swapped");
    const swapped = new ArtifactStore({
      root: swappedRoot,
      publication: {
        unlink: (async (path: string) => {
          await unlink(path);
          await symlink(outside, path);
          throw new Error("injected staging replacement");
        }) as typeof unlink,
      },
    });
    await assert.rejects(swapped.put("owner", "secret"), /lock is retained/);
    assert.ok((await readdir(swappedRoot)).includes(".lock"));
    assert.equal(await readFile(outside, "utf8"), "untouched");

    const failedRoot = join(parent, "failure");
    const failedStore = new ArtifactStore({
      root: failedRoot,
      publication: {
        unlink: (async () => {
          throw Object.assign(new Error("persistent injected failure"), {
            code: "EIO",
          });
        }) as typeof unlink,
      },
    });
    await assert.rejects(
      failedStore.put("owner", "secret"),
      /lock is retained/,
    );
    assert.ok((await readdir(failedRoot)).includes(".lock"));
    const names = (await readdir(failedRoot)).filter(
      (name) => name !== ".lock",
    );
    assert.equal(names.length, 2);
    assert.equal((await lstat(join(failedRoot, names[0]))).nlink, 2);
    assert.equal(await readFile(outside, "utf8"), "untouched");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(failedStore.cleanup(controller.signal), /cancelled/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("crash between link and unlink retains the lock and never exposes a partial publication", async () => {
  const { parent, root } = await fixture();
  try {
    const helper = fileURLToPath(
      new URL("./artifact-test-helper.mjs", import.meta.url),
    );
    const signal = await new Promise<NodeJS.Signals | null>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [
          "--experimental-strip-types",
          helper,
          root,
          "owner",
          "crash-after-link",
        ]);
        child.on("error", reject);
        child.on("close", (_code, signal) => resolve(signal));
      },
    );
    assert.equal(signal, "SIGKILL");
    const names = await readdir(root);
    assert.ok(names.includes(".lock"));
    const files = names.filter((name) => name !== ".lock");
    assert.equal(files.length, 2);
    for (const name of files) {
      assert.equal((await lstat(join(root, name))).nlink, 2);
      assert.equal(await readFile(join(root, name), "utf8"), "x".repeat(60));
    }
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      new ArtifactStore({ root }).cleanup(controller.signal),
      /cancelled/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("quota coordinates independent processes", async () => {
  const { parent, root } = await fixture();
  try {
    const helper = fileURLToPath(
      new URL("./artifact-test-helper.mjs", import.meta.url),
    );
    const run = (owner: string) =>
      new Promise<{ code: number | null; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [
            "--experimental-strip-types",
            helper,
            root,
            owner,
          ]);
          let stderr = "";
          child.stderr.on("data", (data) => (stderr += data));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stderr }));
        },
      );
    const results = await Promise.all([run("first"), run("second")]);
    assert.deepEqual(results.map((x) => x.code).sort(), [0, 1]);
    assert.match(results.find((x) => x.code === 1)!.stderr, /quota/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("symlinks, hard links, unsafe roots and unrelated entries fail closed", async () => {
  const { parent, root } = await fixture();
  try {
    const store = new ArtifactStore({ root });
    const artifact = await store.put("owner", "secret");
    const target = join(parent, "target");
    await writeFile(target, "original");
    await symlink(target, join(parent, "dest"));
    await assert.rejects(
      store.export("owner", artifact.id, join(parent, "dest")),
      /EEXIST/,
    );
    await symlink(parent, join(parent, "linkdir"));
    await assert.rejects(
      store.export("owner", artifact.id, join(parent, "linkdir", "out")),
      /symlink/,
    );
    await link(artifact.path, join(parent, "hardlink"));
    await assert.rejects(store.read("owner", artifact.id), /Unsafe artifact/);
    assert.equal(await readFile(target, "utf8"), "original");
    await rm(join(parent, "hardlink"));
    await rm(artifact.path);
    await symlink(target, artifact.path);
    await assert.rejects(store.cleanup(), /ELOOP|Unsafe/);
    assert.equal(await readFile(target, "utf8"), "original");
    await rm(artifact.path);
    await writeFile(join(root, "unrelated"), "safe");
    await assert.rejects(store.cleanup(), /unknown/);
    assert.equal(await readFile(join(root, "unrelated"), "utf8"), "safe");
    const bad = join(parent, "badroot");
    await symlink(root, bad);
    await assert.rejects(new ArtifactStore({ root: bad }).cleanup());
    await assert.rejects(
      new ArtifactStore({
        root: join(parent, "linkdir", "new-managed"),
      }).cleanup(),
      /symlinks/,
    );
    await assert.rejects(stat(join(parent, "new-managed")), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("lock protects in-use files; cancellation leaves them untouched and orphan staging consumes quota", async () => {
  const { parent, root } = await fixture();
  try {
    let now = 1700000000000;
    const store = new ArtifactStore({
      root,
      quota: 20,
      ttl: 1,
      now: () => now,
    });
    const item = await store.put("o", "hello");
    const cancelled = AbortSignal.abort();
    await assert.rejects(
      store.export("o", item.id, join(parent, "cancelled"), cancelled),
      /cancelled/,
    );
    await assert.rejects(stat(join(parent, "cancelled")), /ENOENT/);
    now += 2;
    await mkdir(join(root, ".lock"));
    const controller = new AbortController();
    const cleaning = store.cleanup(controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(cleaning, /cancelled/);
    assert.equal(await readFile(item.path, "utf8"), "hello");
    await rm(join(root, ".lock"), { recursive: true });
    await store.cleanup();
    await writeFile(
      join(root, ".tmp-00000000-0000-4000-8000-000000000000"),
      "x".repeat(20),
      { mode: 0o600 },
    );
    await assert.rejects(store.put("o", "x"), /quota/);
    assert.ok((await readdir(root)).some((x) => x.startsWith(".tmp-")));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
