import { ArtifactStore } from "./artifacts.ts";
const store = new ArtifactStore({
  root: process.argv[2],
  quota: 100,
  ...(process.argv[4] === "crash-after-link"
    ? {
        publication: {
          unlink: async () => {
            process.kill(process.pid, "SIGKILL");
            await new Promise(() => {});
          },
        },
      }
    : {}),
});
try {
  await store.put(process.argv[3], "x".repeat(60));
  console.log("saved");
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
