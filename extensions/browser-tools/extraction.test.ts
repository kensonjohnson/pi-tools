import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPage, registerExtractionTools } from "./extraction.ts";

function page(items: any[]) {
  return {
    context: () => ({
      newCDPSession: async () => ({
        send: async (name: string) => {
          if (name === "Page.getFrameTree")
            return { frameTree: { frame: { id: "frame" } } };
          if (name === "Page.createIsolatedWorld")
            return { executionContextId: 1 };
          if (name === "Runtime.evaluate")
            return {
              result: {
                value: {
                  items,
                  title: null,
                  url: "https://user:pass@example.test/page?token=secret#frag",
                  base: "https://example.test/base/",
                  retrievedAt: 1234567890000,
                },
              },
            };
          throw new Error(name);
        },
        detach: async () => {},
      }),
    }),
  } as any;
}

test("rendering redacts URL credentials, resolves links and uses captured time", async () => {
  const result = await extractPage(
    page([
      { kind: "open", tag: "h2" },
      { kind: "text", value: "Heading" },
      { kind: "close", tag: "h2" },
      { kind: "open", tag: "a", href: "../next?token=secret" },
      { kind: "text", value: "next" },
      { kind: "close", tag: "a" },
      {
        kind: "text",
        value: "https://user:password@example.test/?token=secret#frag",
      },
    ]),
    { selector: "main" },
    "https://user:pass@example.test/?code=secret#frag",
  );
  assert.equal(result.method, "selector");
  assert.equal(result.title, null);
  assert.equal(result.publicationTime, null);
  assert.equal(result.retrievedAt, new Date(1234567890000).toISOString());
  assert.deepEqual(result.headings, [{ level: 2, text: "Heading" }]);
  assert.match(result.links[0].url, /redacted/i);
  assert.doesNotMatch(
    JSON.stringify(result),
    /token=secret|code=secret|password|user:pass|#frag/,
  );
});

test("navigation during capture never resolves a stale requested URL", async () => {
  let count = 0,
    resolved = false;
  const fake = {
    context: () => ({
      newCDPSession: async () => ({
        send: async (name: string) => {
          if (name === "Page.getFrameTree")
            return {
              frameTree: {
                frame: {
                  id: "f",
                  loaderId: ++count === 1 ? "old" : "new",
                  url: "https://example.test/",
                },
              },
            };
          if (name === "Page.createIsolatedWorld")
            return { executionContextId: 1 };
          if (name === "Runtime.evaluate")
            return {
              result: {
                value: {
                  items: [{ kind: "text", value: "current" }],
                  title: null,
                  url: "https://example.test/",
                  base: "https://example.test/",
                  retrievedAt: 1234567890000,
                },
              },
            };
          throw new Error(name);
        },
        detach: async () => {},
      }),
    }),
  } as any;
  const result = await extractPage(fake, {}, () => {
    resolved = true;
    return "https://example.test/old";
  });
  assert.equal(result.requestedUrl, null);
  assert.equal(resolved, false);
});

test("about document identities retain no query or fragment secrets", async () => {
  const result = await extractPage(
    page([{ kind: "text", value: "hello" }]),
    {},
    "about:srcdoc?token=secret#secret",
  );
  assert.equal(result.requestedUrl, "about:srcdoc?[redacted]#[redacted]");
});

test("empty content fails and registration uses injected owner and target", async () => {
  await assert.rejects(extractPage(page([])), /no readable text/);
  const tools = new Map<string, any>();
  let called = false;
  registerExtractionTools(
    { registerTool: (tool: any) => tools.set(tool.name, tool) } as any,
    () => ({
      artifacts: {} as any,
      owner: "owner",
      runPage: async (target, _signal, work) => {
        assert.deepEqual(target, { sessionId: "s", tabId: "t" });
        called = true;
        return work(
          page([{ kind: "text", value: "hello" }]),
          { sessionId: "s", tabId: "t" },
          null,
        );
      },
    }),
  );
  const response = await tools
    .get("browser_extract")
    .execute("id", { sessionId: "s", tabId: "t" });
  assert.ok(called);
  const output = JSON.parse(response.content[0].text);
  assert.equal(output.untrusted, true);
  assert.equal(JSON.parse(output.text).text, "hello");
});
