import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "chooser supports hidden inputs, strict labels, MIME inference, overrides and descriptor-pinned parent symlinks",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "upload-chooser-")),
    );
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
    });
    try {
      await mkdir(join(root, "actual"));
      await writeFile(join(root, "actual", "photo.png"), "image bytes");
      await writeFile(join(root, "actual", "other.unknown"), "other bytes");
      await symlink(join(root, "actual"), join(root, "alias"));
      await symlink(
        join(root, "actual", "photo.png"),
        join(root, "final-link"),
      );
      const page = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      const html = `<input id="file" type="file" multiple style="display:none"><label for="file" id="choose">Choose file</label><label for="file" class="duplicate">A</label><label for="file" class="duplicate">B</label><button onclick="document.querySelector('#file').click()">Open file</button><iframe id="child" srcdoc="<section id='scope'><input id='f' type='file' style='display:none'><label for='f'>Frame chooser</label></section>"></iframe>`;
      await sessions.navigate(
        `data:text/html,${encodeURIComponent(html)}`,
        page,
        undefined,
        30000,
        "owner",
      );
      const upload = (opts: Record<string, unknown>, owner = "owner") =>
        sessions.upload(page, owner, {
          mode: "chooser",
          paths: ["alias/photo.png"],
          cwd: root,
          maxFileBytes: 100,
          maxTotalBytes: 100,
          timeoutMs: 5000,
          ...opts,
        });
      await assert.rejects(upload({ selector: ".duplicate" }), /matched 2/);
      await assert.rejects(
        upload({ selector: "#choose" }, "foreign"),
        /Session unavailable/,
      );
      await assert.rejects(
        upload({ selector: "#choose", paths: ["final-link"] }),
        /could not be read/,
      );
      const result: any = await upload({ selector: "#choose" });
      assert.equal(result.status, "completed");
      const read = (expression: string) =>
        sessions.evaluate(expression, page, undefined, "owner");
      assert.equal(
        ((await read("document.querySelector('#file').files[0].type")) as any)
          .text,
        "image/png",
      );
      assert.equal(
        ((await read("document.querySelector('#file').files[0].text()")) as any)
          .text,
        "image bytes",
      );
      const role: any = await upload({
        role: "button",
        name: "Open file",
        paths: ["actual/other.unknown"],
        mimeTypes: ["application/x-example"],
      });
      assert.equal(role.status, "completed");
      assert.equal(
        ((await read("document.querySelector('#file').files[0].type")) as any)
          .text,
        "application/x-example",
      );
      await assert.rejects(
        upload({ selector: "#choose", mimeTypes: ["invalid"] }),
        /valid MIME/,
      );
      await assert.rejects(
        upload({ selector: "#choose", mode: "input" }),
        /snapshot ref/,
      );
      await read(
        "(() => setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<label id=late for=file>Late</label>'), 150))()",
      );
      const delayed: any = await upload({ selector: "#late", timeoutMs: 2000 });
      assert.equal(delayed.status, "completed");
      await assert.rejects(
        upload({ selector: "#missing", timeoutMs: 150 }),
        /upload deadline/,
      );
      const frameResult: any = await upload({
        frameSelector: "#child",
        scopeSelector: "#scope",
        selector: "label",
      });
      assert.equal(frameResult.status, "completed");
      const type = await sessions.withOwnedPage(
        page,
        undefined,
        "owner",
        async (owned) =>
          owned
            .frames()[1]
            .evaluate(
              () =>
                (document.querySelector("#f") as HTMLInputElement).files?.[0]
                  .type,
            ),
      );
      assert.equal(type, "image/png");
    } finally {
      await sessions.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
