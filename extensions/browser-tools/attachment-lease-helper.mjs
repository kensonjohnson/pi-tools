import { EventEmitter } from "node:events";
import { AttachmentLeases } from "./attachment-leases.ts";
const page = Object.assign(new EventEmitter(), { isClosed: () => false });
const context = {
  pages: () => [page],
  newCDPSession: async () => ({
    send: async () => ({ targetInfo: { type: "page", targetId: "target" } }),
    detach: async () => {},
  }),
};
const browser = Object.assign(new EventEmitter(), {
  contexts: () => [context],
});
const lease = new AttachmentLeases(
  { browser, disconnect() {} },
  "http://[::1]:22222",
  { lockRoot: process.argv[2] },
);
await lease.select("child", "target");
process.stdout.write("ready\n");
process.stdin.resume();
process.stdin.once("data", async () => {
  await lease.disconnect();
  process.exit(0);
});
