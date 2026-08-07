import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  COMPLETION_INBOX_MESSAGE_TYPE,
  CompletionInbox,
  CompletionInboxDelivery,
} from "./completion-inbox.ts";

async function createRecord(inbox: CompletionInbox, number: number) {
  return inbox.create({
    workstreamId: `workstream-${number}`,
    kind: number % 2 ? "task" : "research",
    terminalStatus: number % 2 ? "settled" : "blocked",
    handoff: `Worker ${number} completed with a bounded handoff.`,
    artifactReferences: [
      `tmp/subagents/workstream-${number}/reports/0001.json`,
    ],
    sourceCustomType: "pi-tools:subagent-task-handoff",
    sourceDetails: { workstreamId: `workstream-${number}` },
  });
}

test("persists scheduled inbox records across reload until matching delivery acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-completion-inbox-"));
  const sent: Array<{ message: any; options: any }> = [];
  try {
    const inbox = new CompletionInbox(root);
    const record = await createRecord(inbox, 1);
    const delivery = new CompletionInboxDelivery(
      {
        sendMessage(message, options) {
          sent.push({ message, options });
        },
      } as any,
      inbox,
    );

    assert.equal(await delivery.schedule(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.message.customType, COMPLETION_INBOX_MESSAGE_TYPE);
    assert.deepEqual(sent[0]?.options, { deliverAs: "nextTurn" });
    assert.equal((await inbox.list())[0]?.deliveryState, "scheduled");

    const reloaded = new CompletionInbox(root);
    await reloaded.recoverScheduled();
    assert.equal((await reloaded.list())[0]?.deliveryState, "pending");

    const restartedDelivery = new CompletionInboxDelivery(
      {
        sendMessage(message, options) {
          sent.push({ message, options });
        },
      } as any,
      reloaded,
    );
    await restartedDelivery.schedule();
    const second = sent[1]?.message;
    assert.notEqual(second.details.batchId, sent[0]?.message.details.batchId);
    assert.equal(
      await restartedDelivery.acknowledgeMessage({
        role: "custom",
        customType: COMPLETION_INBOX_MESSAGE_TYPE,
        content: second.content,
        display: true,
        details: second.details,
        timestamp: Date.now(),
      } as AgentMessage),
      1,
    );
    const acknowledged = (await reloaded.list())[0];
    assert.equal(acknowledged?.id, record.id);
    assert.equal(acknowledged?.deliveryState, "acknowledged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consumes explicitly waited records so they cannot be scheduled later", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-completion-inbox-"));
  try {
    const inbox = new CompletionInbox(root);
    const first = await createRecord(inbox, 1);
    const second = await createRecord(inbox, 2);

    const consumed = await inbox.consume([first.id]);
    assert.deepEqual(
      consumed.map((record) => record.id),
      [first.id],
    );
    assert.equal(consumed[0]?.deliveryState, "consumed");
    assert.equal((await inbox.listUnconsumed()).length, 1);

    const delivery = new CompletionInboxDelivery(
      { sendMessage() {} } as any,
      inbox,
    );
    assert.equal(await delivery.schedule(), true);
    const records = await inbox.list();
    assert.equal(
      records.find((record) => record.id === first.id)?.deliveryState,
      "consumed",
    );
    assert.equal(
      records.find((record) => record.id === second.id)?.deliveryState,
      "scheduled",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batches only bounded pending records and never wakes or steers the parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-completion-inbox-"));
  const sent: Array<{ message: any; options: any }> = [];
  try {
    const inbox = new CompletionInbox(root);
    await Promise.all(
      Array.from({ length: 7 }, (_, index) => createRecord(inbox, index + 1)),
    );
    const delivery = new CompletionInboxDelivery(
      {
        sendMessage(message, options) {
          sent.push({ message, options });
        },
      } as any,
      inbox,
    );

    assert.equal(await delivery.schedule(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.message.details.recordIds.length, 6);
    assert.deepEqual(sent[0]?.options, { deliverAs: "nextTurn" });
    assert.equal((await inbox.listUnconsumed()).length, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
