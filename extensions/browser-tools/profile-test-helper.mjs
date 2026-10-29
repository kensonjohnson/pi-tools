import { acquireProfile } from "./profiles.ts";
const lease = await acquireProfile("shared", {
  root: process.argv[2],
  timeoutMs: 5000,
});
process.send?.("acquired");
process.on("message", async (message) => {
  if (message === "release") {
    await lease.release();
    process.exit(0);
  }
});
