import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodeSearchWorkerClient } from "./worker-client.ts";
import {
  registerCodeSearchTools,
  type CodeSearchToolRuntime,
} from "./tools.ts";

test("code tools validate metadata-only discovery and transient literal fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-code-search-tools-"));
  const databasePath = join(root, ".pi", "code-search", "index.sqlite");
  const worker = new CodeSearchWorkerClient();
  const tools = new Map<
    string,
    { execute: (...args: any[]) => Promise<any> }
  >();
  const sourceSecret = "UNIQUE_LIVE_SOURCE_MUST_NOT_APPEAR_IN_DISCOVERY";
  try {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(
      join(root, "docs", "configured.txt"),
      "CONFIGURED_SECRET\n",
    );
    await writeFile(join(root, "ignored.txt"), "GITIGNORE_SECRET\n");
    await writeFile(
      join(root, "sample.ts"),
      `import { helper } from "./helper.ts";\nexport class Greeter {\n  greeting() { return "${sourceSecret}"; }\n}\n`,
    );
    await writeFile(join(root, "broken.ts"), "export function broken( {\n");
    await writeFile(
      join(root, "module.py"),
      "class Parent:\n  def child(self):\n    return 1\n",
    );
    await writeFile(
      join(root, "module.go"),
      "package module\ntype Person struct {}\nfunc Top() {}\n",
    );
    await writeFile(
      join(root, "many.ts"),
      Array.from(
        { length: 40 },
        (_, index) =>
          `export function item${index}() { return "${index === 0 ? "x".repeat(5_000) : ""}"; }\n`,
      ).join(""),
    );
    await worker.initialize(databasePath, root);
    await worker.refresh({ root, additionalIgnores: "docs/**" });
    const runtime: CodeSearchToolRuntime = {
      root,
      additionalIgnores: "docs/**",
      outputStyle: "compact",
      searchMaxResults: 10,
      searchTokenBudget: 1_200,
      retrievalTokenBudget: 4_000,
      contextTokenBudget: 6_000,
      worker,
    };
    registerCodeSearchTools(
      {
        registerTool(definition: {
          name: string;
          execute: (...args: any[]) => Promise<any>;
        }) {
          tools.set(definition.name, definition);
        },
      } as unknown as ExtensionAPI,
      () => runtime,
    );
    const context = { isProjectTrusted: () => true };

    const search = await tools
      .get("code_search")!
      .execute("", { query: "greeting" }, undefined, undefined, context);
    assert.match(search.content[0].text, /greeting/);
    assert.doesNotMatch(search.content[0].text, new RegExp(sourceSecret));

    const literal = await tools
      .get("code_search")!
      .execute(
        "",
        { query: sourceSecret, text: true },
        undefined,
        undefined,
        context,
      );
    assert.match(literal.content[0].text, /literal-text — sample\.ts:3:/);
    assert.doesNotMatch(literal.content[0].text, new RegExp(sourceSecret));
    const ignoredLiteral = await tools
      .get("code_search")!
      .execute(
        "",
        { query: "CONFIGURED_SECRET", text: true },
        undefined,
        undefined,
        context,
      );
    assert.doesNotMatch(ignoredLiteral.content[0].text, /literal-text/);
    const gitIgnoredLiteral = await tools
      .get("code_search")!
      .execute(
        "",
        { query: "GITIGNORE_SECRET", text: true },
        undefined,
        undefined,
        context,
      );
    assert.doesNotMatch(gitIgnoredLiteral.content[0].text, /literal-text/);

    const outline = await tools
      .get("code_outline")!
      .execute("", { path: "sample.ts" }, undefined, undefined, context);
    assert.match(outline.content[0].text, /greeting/);
    assert.doesNotMatch(outline.content[0].text, new RegExp(sourceSecret));

    const pythonOutline = await tools
      .get("code_outline")!
      .execute("", { path: "module.py" }, undefined, undefined, context);
    assert.match(pythonOutline.content[0].text, /class Parent/);
    assert.match(pythonOutline.content[0].text, /function Parent\.child/);
    const goOutline = await tools
      .get("code_outline")!
      .execute("", { path: "module.go" }, undefined, undefined, context);
    assert.match(goOutline.content[0].text, /type Person/);
    assert.match(goOutline.content[0].text, /function Top/);

    runtime.outputStyle = "structured";
    const structured = await tools
      .get("code_outline")!
      .execute("", { path: "sample.ts" }, undefined, undefined, context);
    assert.match(structured.content[0].text, /id: [a-f0-9]{64}/);
    assert.match(structured.content[0].text, /language: typescript/);
    runtime.outputStyle = "compact";
    const malformed = await tools
      .get("code_outline")!
      .execute("", { path: "broken.ts" }, undefined, undefined, context);
    assert.match(malformed.content[0].text, /AST parse errors 1/);

    const budgeted = await tools
      .get("code_search")!
      .execute(
        "",
        { query: "item", maxResults: 100, tokenBudget: 128 },
        undefined,
        undefined,
        context,
      );
    assert.match(
      budgeted.content[0].text,
      /Results omitted: \d+; token budget exhausted/,
    );
    assert.ok(Buffer.byteLength(budgeted.content[0].text) <= 1_024);

    const largeSymbol = (
      await worker.searchSymbols({ query: "item0", limit: 1 })
    )[0]!;
    const clipped = await tools
      .get("code_get")!
      .execute(
        "",
        { id: largeSymbol.id, tokenBudget: 256 },
        undefined,
        undefined,
        context,
      );
    assert.match(clipped.content[0].text, /\[Truncated at \d+ bytes/);
    assert.ok(Buffer.byteLength(clipped.content[0].text) <= 1_024);

    const pythonChild = (
      await worker.searchSymbols({ query: "child", limit: 1 })
    )[0]!;
    const pythonGet = await tools
      .get("code_get")!
      .execute("", { id: pythonChild.id }, undefined, undefined, context);
    assert.match(pythonGet.content[0].text, /def child\(self\):/);

    const symbol = (
      await worker.searchSymbols({ query: "greeting", limit: 1 })
    )[0]!;
    await writeFile(
      join(root, "sample.ts"),
      'import { helper } from "./helper.ts";\nexport class Greeter {\n  greeting() { return "CURRENT_LIVE_SOURCE"; }\n}\n',
    );
    const get = await tools
      .get("code_get")!
      .execute("", { id: symbol.id }, undefined, undefined, context);
    assert.match(get.content[0].text, /CURRENT_LIVE_SOURCE/);
    assert.doesNotMatch(get.content[0].text, new RegExp(sourceSecret));

    const codeContext = await tools
      .get("code_context")!
      .execute("", { ids: [symbol.id] }, undefined, undefined, context);
    assert.match(codeContext.content[0].text, /CURRENT_LIVE_SOURCE/);
    assert.match(
      codeContext.content[0].text,
      /import \{ helper \} from "\.\/helper\.ts"/,
    );
    assert.match(
      codeContext.content[0].text,
      /Containing header\nclass Greeter/,
    );

    const targetFirstContext = await tools
      .get("code_context")!
      .execute(
        "",
        { ids: [largeSymbol.id, symbol.id], tokenBudget: 256 },
        undefined,
        undefined,
        context,
      );
    assert.match(
      targetFirstContext.content[0].text,
      /Omitted: \d+; target budget priority/,
    );
    assert.ok(Buffer.byteLength(targetFirstContext.content[0].text) <= 1_024);
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
