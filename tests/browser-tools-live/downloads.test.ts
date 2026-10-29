import { test } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext } from "playwright";
import { launchFixtureBrowser, within } from "./download-test-helper.ts";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadManager } from "../../extensions/browser-tools/downloads.ts";
import { ArtifactStore } from "../../extensions/browser-tools/artifacts.ts";

function pdfFixture(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

for (const { name, mime, bytes } of [
  {
    name: "report.csv",
    mime: "text/csv",
    bytes: Buffer.from('name,amount\r\n"café, inc.",42\r\n', "utf8"),
  },
  { name: "report.pdf", mime: "application/pdf", bytes: pdfFixture() },
]) {
  test(
    `completed ${name} is retained byte-for-byte after context close`,
    { timeout: 30000 },
    async () => {
      const dir = await realpath(
        await mkdtemp(join(tmpdir(), "browser-download-format-")),
      );
      let fixture: Awaited<ReturnType<typeof launchFixtureBrowser>> | undefined;
      const store = new ArtifactStore({ root: join(dir, "artifacts") });
      const manager = new DownloadManager({
        sink: store,
        operationTimeoutMs: 1000,
      });
      try {
        fixture = await launchFixtureBrowser(
          process.env.BROWSER_HEADED !== "1",
        );
        const context = await fixture.browser.newContext({
          acceptDownloads: true,
        });
        const page = await context.newPage();
        manager.attach({ sessionId: "owner", tabId: "tab" }, page);
        await page.goto("data:text/html,<html><body></body></html>");
        await page.evaluate(
          ({ name, mime, data }) => {
            const a = document.createElement("a");
            a.download = name;
            a.href = URL.createObjectURL(
              new Blob([new Uint8Array(data)], { type: mime }),
            );
            document.body.append(a);
            a.click();
          },
          { name, mime, data: [...bytes] },
        );
        for (let i = 0; i < 100 && !manager.list("owner").length; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        const record = manager.list("owner")[0];
        assert.ok(record);
        const done = await manager.wait("owner", record.id, {
          timeoutMs: 5000,
        });
        assert.equal(done.state, "complete");
        assert.equal(done.suggestedName, name);
        assert.equal(done.artifact!.bytes, bytes.length);
        await within(manager.endSession("owner"));
        await within(context.close());
        assert.deepEqual(await readFile(done.artifact!.path), bytes);
        const chunk = await store.readBinary("owner", done.artifact!.id);
        assert.equal(chunk.encoding, "base64");
        assert.equal(chunk.nextOffset, null);
        assert.deepEqual(Buffer.from(chunk.data, "base64"), bytes);
        await assert.rejects(
          store.readBinary("other", done.artifact!.id),
          /owned by another/,
        );
      } finally {
        try {
          await within(manager.shutdown());
        } finally {
          await fixture?.close();
          await rm(dir, { recursive: true, force: true });
        }
      }
    },
  );
}

test(
  "page download survives context closure with exact binary bytes",
  { timeout: 30000 },
  async () => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "browser-download-test-")),
    );
    let fixture: Awaited<ReturnType<typeof launchFixtureBrowser>> | undefined;
    let context: BrowserContext | undefined;
    const store = new ArtifactStore({ root: join(dir, "artifacts") });
    const manager = new DownloadManager({
      sink: store,
      operationTimeoutMs: 1000,
    });
    try {
      fixture = await launchFixtureBrowser(process.env.BROWSER_HEADED !== "1");
      context = await fixture.browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      manager.attach({ sessionId: "s", tabId: "t" }, page);
      await page.goto("data:text/html,<html><body></body></html>");
      await page.evaluate(() => {
        const a = document.createElement("a");
        a.download = "fixture.bin";
        a.href = URL.createObjectURL(
          new Blob([new Uint8Array([0, 255, 13, 42])]),
        );
        document.body.append(a);
        a.click();
      });
      for (let i = 0; i < 100 && !manager.list("s").length; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const record = manager.list("s")[0];
      assert.ok(record);
      const done = await manager.wait("s", record.id, { timeoutMs: 5000 });
      assert.equal(done.state, "complete");
      await within(manager.endSession("s"));
      await within(context.close());
      assert.equal(
        (await store.readBinary("s", done.artifact!.id)).data,
        Buffer.from([0, 255, 13, 42]).toString("base64"),
      );
      assert.deepEqual(
        await readFile(done.artifact!.path),
        Buffer.from([0, 255, 13, 42]),
      );
    } finally {
      try {
        await within(manager.shutdown());
      } finally {
        await fixture?.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
);
