import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ManagedSessions } from "./sessions.ts";

test(
  "owned dialog responses are explicit and uploads use exact bounded local files",
  { skip: !existsSync(chromium.executablePath()), timeout: 30000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "browser-dialog-upload-")),
    );
    const sessions = new ManagedSessions({
      launch: ({ headless }) => chromium.launch({ headless }),
    });
    try {
      await writeFile(join(root, "a.txt"), "abc");
      await writeFile(join(root, "b.txt"), "defg");
      await symlink(join(root, "a.txt"), join(root, "link"));
      const target = await sessions.start({
        headless: true,
        artifactOwner: "owner",
      });
      const html = `<input type="file" id="files" multiple><button id="choose" onclick="document.querySelector('#files').click()">Choose</button><button id="confirm" onclick="window.answer=confirm('Continue?')">Confirm</button><button id="prompt" onclick="window.answer=prompt('Value?','default')">Prompt</button><button id="alert" onclick="alert('Notice')">Alert</button>`;
      await sessions.navigate(
        `data:text/html,${encodeURIComponent(html)}`,
        target,
        undefined,
        30000,
        "owner",
      );
      const capture = await sessions.snapshot(target, "owner", undefined, {
        selector: "#files",
      });
      const ref = capture.snapshot.records.find((record) => record.ref)?.ref;
      assert.ok(ref);
      const upload = (paths: string[], owner = "owner", maxFileBytes = 100) =>
        sessions.upload(target, owner, {
          ref,
          paths,
          cwd: root,
          maxFileBytes,
          maxTotalBytes: 100,
          timeoutMs: 5000,
        });
      assert.equal(
        ((await upload(["a.txt", "b.txt"])) as any).status,
        "completed",
      );
      const files = await sessions.evaluate(
        "Promise.all([...document.querySelector('#files').files].map(async f => f.name+':'+await f.text()))",
        target,
        undefined,
        "owner",
      );
      assert.equal(files.text, '["a.txt:abc","b.txt:defg"]');
      await assert.rejects(upload(["missing"]), /could not be read/);
      await assert.rejects(upload(["link"]), /could not be read/);
      await assert.rejects(upload([root]), /could not be read/);
      await assert.rejects(upload(["*.txt"]), /Invalid explicit upload path/);
      await assert.rejects(upload(["a.txt"], "owner", 2), /could not be read/);
      await assert.rejects(
        sessions.upload(target, "owner", {
          ref,
          paths: ["a.txt", "b.txt"],
          cwd: root,
          maxFileBytes: 100,
          maxTotalBytes: 5,
          timeoutMs: 5000,
        }),
        /could not be read/,
      );
      await assert.rejects(upload(["a.txt"], "foreign"), /Session unavailable/);
      const chooserSnapshot = await sessions.snapshot(
        target,
        "owner",
        undefined,
        { selector: "#choose" },
      );
      const chooserRef = chooserSnapshot.snapshot.records.find(
        (record) => record.ref,
      )?.ref;
      assert.ok(chooserRef);
      const chooserResult: any = await sessions.upload(target, "owner", {
        ref: chooserRef,
        mode: "chooser",
        paths: ["b.txt"],
        cwd: root,
        maxFileBytes: 100,
        maxTotalBytes: 100,
        timeoutMs: 5000,
      });
      assert.equal(chooserResult.status, "completed");
      assert.equal(
        (
          await sessions.evaluate(
            "document.querySelector('#files').files[0].text()",
            target,
            undefined,
            "owner",
          )
        ).text,
        "defg",
      );
      const runDialog = async (
        selector: string,
        response: "accept" | "dismiss",
        promptText?: string,
      ) => {
        const pending: any = await sessions.action(target, "owner", {
          action: "click",
          target: { selector },
          timeoutMs: 5000,
        });
        assert.equal(pending.status, "awaiting_dialog");
        assert.ok(pending.operationId && pending.dialog.id);
        const initialState = await sessions.dialog(target, "owner", {
          action: "operation",
          operationId: pending.operationId,
        });
        assert.equal(initialState.status, "pending");
        await assert.rejects(
          sessions.dialog(target, "foreign", { action: "inspect" }),
          /Session unavailable/,
        );
        await assert.rejects(
          sessions.dialog(target, "owner", { action: response, id: "wrong" }),
          /does not match/,
        );
        await assert.rejects(
          sessions.action(target, "owner", {
            action: "click",
            target: { selector },
          }),
          /dialog is pending/,
        );
        const inspected = await sessions.dialog(target, "owner", {
          action: "inspect",
        });
        assert.equal(inspected.status, "awaiting_dialog");
        const resolved = await sessions.dialog(target, "owner", {
          action: response,
          id: pending.dialog.id,
          promptText,
        });
        assert.equal(resolved.status, "resolved");
        for (let i = 0; i < 100; i++) {
          const status = await sessions.dialog(target, "owner", {
            action: "operation",
            operationId: pending.operationId,
          });
          if (status.status === "settled") return status;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Origin did not settle");
      };
      await sessions.evaluate(
        "(() => { document.querySelector('#files').onchange = () => alert('Uploaded'); })()",
        target,
        undefined,
        "owner",
      );
      const inputAgain = await sessions.snapshot(target, "owner", undefined, {
        selector: "#files",
      });
      const uploadRef = inputAgain.snapshot.records.find(
        (record) => record.ref,
      )?.ref;
      assert.ok(uploadRef);
      const uploadDialog: any = await sessions.upload(target, "owner", {
        ref: uploadRef,
        paths: ["a.txt"],
        cwd: root,
        maxFileBytes: 100,
        maxTotalBytes: 100,
        timeoutMs: 5000,
      });
      assert.equal(uploadDialog.status, "awaiting_dialog");
      await sessions.dialog(target, "owner", {
        action: "dismiss",
        id: uploadDialog.dialog.id,
      });
      for (let i = 0; i < 100; i++) {
        if (
          (
            await sessions.dialog(target, "owner", {
              action: "operation",
              operationId: uploadDialog.operationId,
            })
          ).status === "settled"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await runDialog("#confirm", "dismiss");
      assert.equal(
        (await sessions.evaluate("window.answer", target, undefined, "owner"))
          .text,
        "false",
      );
      await runDialog("#prompt", "accept", "chosen");
      assert.equal(
        (await sessions.evaluate("window.answer", target, undefined, "owner"))
          .text,
        "chosen",
      );
      await runDialog("#alert", "dismiss");
      await sessions.evaluate(
        "(() => { window.onbeforeunload = e => { e.preventDefault(); e.returnValue = 'leave'; }; })()",
        target,
        undefined,
        "owner",
      );
      const navigation: any = await sessions.navigate(
        "about:blank",
        target,
        undefined,
        5000,
        "owner",
      );
      assert.equal(navigation.status, "awaiting_dialog");
      assert.equal(navigation.dialog.type, "beforeunload");
      await sessions.dialog(target, "owner", {
        action: "dismiss",
        id: navigation.dialog.id,
      });
      for (let i = 0; i < 100; i++) {
        if (
          (
            await sessions.dialog(target, "owner", {
              action: "operation",
              operationId: navigation.operationId,
            })
          ).status === "settled"
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const close: any = await sessions.closeTab(target, undefined, "owner");
      assert.equal(close.status, "awaiting_dialog");
      assert.equal(close.dialog.type, "beforeunload");
      await sessions.dialog(target, "owner", {
        action: "dismiss",
        id: close.dialog.id,
      });
      for (let i = 0; i < 100; i++) {
        const state: any = await sessions.dialog(target, "owner", {
          action: "operation",
          operationId: close.operationId,
        });
        if (state.status === "settled") {
          assert.equal(state.result.closed, false);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await sessions.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
