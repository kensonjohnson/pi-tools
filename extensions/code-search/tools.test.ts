import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodeSearchWorkerClient } from "./worker-client.ts";
import {
  registerCodeSearchTools,
  type CodeSearchToolRuntime,
} from "./tools.ts";

test("code tools validate symbols and read source only for get/context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-code-search-tools-"));
  const databasePath = join(root, ".pi", "code-search", "index.sqlite");
  const worker = new CodeSearchWorkerClient();
  const tools = new Map<
    string,
    { execute: (...args: any[]) => Promise<any> }
  >();
  const sourceSecret = "UNIQUE_LIVE_SOURCE_MUST_NOT_APPEAR_IN_DISCOVERY";
  try {
    await writeFile(
      join(root, "sample.ts"),
      `import { helper } from "./helper.ts";\nexport class Greeter {\n  greeting() { return "${sourceSecret}"; }\n}\n`,
    );
    await worker.initialize(databasePath, root);
    await worker.refresh({ root, additionalIgnores: "" });
    const runtime: CodeSearchToolRuntime = {
      root,
      additionalIgnores: "",
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

    const outline = await tools
      .get("code_outline")!
      .execute("", { path: "sample.ts" }, undefined, undefined, context);
    assert.match(outline.content[0].text, /greeting/);
    assert.doesNotMatch(outline.content[0].text, new RegExp(sourceSecret));

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
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
