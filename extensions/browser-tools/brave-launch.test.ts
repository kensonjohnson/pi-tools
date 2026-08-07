import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { launchBrave } from "./brave-launch.ts";

test("rejects a missing Brave executable without an unhandled child-process error", async () => {
  const executable = join(tmpdir(), "pi-tools-brave-does-not-exist");

  await assert.rejects(
    launchBrave({
      executable,
      args: [],
      spawnOptions: { stdio: "ignore" },
    }),
    new RegExp(`executable was not found at ${executable}`),
  );
});
