import { ArtifactStore } from "./artifacts.ts";
const store = new ArtifactStore({ root: process.argv[2], quota: 100 });
try {
  if (process.argv[3] === "binary") {
    await store.putBinary(
      "binary",
      (async function* () {
        yield Buffer.alloc(60, 255);
      })(),
      { maxBytes: 60 },
    );
  } else await store.put("text", "x".repeat(60));
} catch {
  process.exitCode = 1;
}
