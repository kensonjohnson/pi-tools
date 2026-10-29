import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { verifyForkCopy, type ReviewBatch } from "./session-review.ts";

type Entry = {
  id: string;
  parentId: string | null;
  type: string;
  message?: any;
  [key: string]: any;
};
async function readSession(path: string) {
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > 8 * 1024 * 1024 || before.size === 0)
      throw new Error("session source unavailable or oversized");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await fd.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!result.bytesRead) throw new Error("session source truncated");
      offset += result.bytesRead;
    }
    const after = await fd.stat();
    const live = await lstat(path);
    if (
      !live.isFile() ||
      live.dev !== after.dev ||
      live.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.at(-1) !== 10
    )
      throw new Error("session source changed or incomplete");
    const rows = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .split("\n");
    rows.pop();
    const [header, ...entries] = rows.map((line) => JSON.parse(line));
    if (
      !header ||
      header.type !== "session" ||
      header.version !== 3 ||
      typeof header.id !== "string" ||
      typeof header.cwd !== "string"
    )
      throw new Error("invalid or unsupported session source");
    const byId = new Map<string, Entry>();
    for (const e of entries) {
      if (
        !e ||
        typeof e.id !== "string" ||
        byId.has(e.id) ||
        (e.parentId !== null &&
          (typeof e.parentId !== "string" || !byId.has(e.parentId)))
      )
        throw new Error("invalid session source tree");
      byId.set(e.id, e);
    }
    const pathEntries: Entry[] = [];
    let id = entries.at(-1)?.id ?? null;
    while (id !== null) {
      const entry = byId.get(id)!;
      pathEntries.push(entry);
      id = entry.parentId;
    }
    pathEntries.reverse();
    return { header, entries: entries as Entry[], pathEntries };
  } finally {
    await fd.close();
  }
}
function messageText(content: unknown, role: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || (role === "user" && content.length === 0))
    throw new Error("unsupported session message content");
  const text: string[] = [];
  for (const b of content) {
    if (b && b.type === "text" && typeof b.text === "string") text.push(b.text);
    else if (
      role === "assistant" &&
      b &&
      (b.type === "thinking" || b.type === "toolCall")
    )
      continue;
    else throw new Error("unsupported session message content");
  }
  return text.join("\n");
}
/** Revalidate cited items against the current persisted active branch before model exposure and apply. */
export async function validateSessionBatch(
  project: string,
  batch: ReviewBatch,
): Promise<void> {
  if (
    !isAbsolute(batch.path) ||
    !batch.sessionId ||
    (batch.leaf !== null && typeof batch.leaf !== "string")
  )
    throw new Error("invalid session batch identity");
  const cwd = resolve(project);
  const seen = new Set<string>();
  let path: string | undefined = batch.path;
  let child = true;
  let childEntries: Entry[] | undefined;
  while (path !== undefined) {
    if (!isAbsolute(path) || seen.has(path) || seen.size >= 9)
      throw new Error("invalid or excessive fork provenance");
    seen.add(path);
    const source = await readSession(path);
    if (resolve(source.header.cwd) !== cwd)
      throw new Error("foreign session provenance");
    if (childEntries && !verifyForkCopy(childEntries, source.entries))
      throw new Error(
        "fork copied history is unverifiable or tampered; excluded",
      );
    childEntries = source.entries;
    if (child) {
      if (source.header.id !== batch.sessionId)
        throw new Error("session source identity changed");
      const leafIndex =
        batch.leaf === null
          ? -1
          : source.pathEntries.findIndex((e) => e.id === batch.leaf);
      if (batch.leaf !== null && leafIndex < 0)
        throw new Error("session branch changed");
      let previous = -1;
      for (const item of batch.items) {
        const index = source.pathEntries.findIndex((e) => e.id === item.id);
        if (index <= previous || index > leafIndex)
          throw new Error("session item is not on the reviewed active branch");
        const entry = source.pathEntries[index];
        if (
          entry.type !== "message" ||
          entry.message?.role !== item.role ||
          !["user", "assistant"].includes(item.role) ||
          messageText(entry.message.content, item.role) !== item.text
        )
          throw new Error("session item changed or is unsupported");
        previous = index;
      }
      child = false;
    }
    const parent: unknown = source.header.parentSession;
    if (
      parent !== undefined &&
      (typeof parent !== "string" || !isAbsolute(parent))
    )
      throw new Error("invalid fork provenance");
    path = parent as string | undefined;
  }
}
