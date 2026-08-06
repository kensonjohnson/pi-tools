import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentWorkstreamKind } from "./settings.ts";
import type { WorkstreamStatus } from "./supervisor.ts";

export const COMPLETION_INBOX_MESSAGE_TYPE =
  "pi-tools:subagent-completion-inbox";
const MAX_BATCH_RECORDS = 6;
const MAX_BATCH_CHARS = 7_200;

export type CompletionInboxDeliveryState =
  "pending" | "scheduled" | "acknowledged" | "consumed";

export type CompletionInboxRecord = {
  version: 1;
  id: string;
  workstreamId: string;
  kind: SubagentWorkstreamKind;
  terminalStatus: Extract<
    WorkstreamStatus,
    "settled" | "blocked" | "needs_decision"
  >;
  handoff: string;
  artifactReferences: string[];
  sourceCustomType: string;
  sourceDetails: Record<string, unknown>;
  deliveryState: CompletionInboxDeliveryState;
  createdAt: string;
  scheduledAt?: string;
  deliveryBatchId?: string;
  acknowledgedAt?: string;
  consumedAt?: string;
};

export type CreateCompletionInboxRecord = Omit<
  CompletionInboxRecord,
  | "version"
  | "id"
  | "deliveryState"
  | "createdAt"
  | "scheduledAt"
  | "deliveryBatchId"
  | "acknowledgedAt"
  | "consumedAt"
>;

type ScheduledBatch = {
  id: string;
  records: CompletionInboxRecord[];
};

export class CompletionInbox {
  readonly directory: string;

  constructor(rootDirectory: string) {
    this.directory = join(rootDirectory, "completion-inbox");
  }

  async create(
    input: CreateCompletionInboxRecord,
  ): Promise<CompletionInboxRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const record: CompletionInboxRecord = {
      version: 1,
      id: randomUUID(),
      ...input,
      deliveryState: "pending",
      createdAt: new Date().toISOString(),
    };
    await this.write(record);
    return record;
  }

  async list(): Promise<CompletionInboxRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => this.read(name)),
    );
    return records
      .filter((record): record is CompletionInboxRecord => Boolean(record))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listUnconsumed(): Promise<CompletionInboxRecord[]> {
    return (await this.list()).filter(
      (record) =>
        record.deliveryState === "pending" ||
        record.deliveryState === "scheduled",
    );
  }

  async recoverScheduled(): Promise<void> {
    for (const record of await this.list()) {
      if (record.deliveryState !== "scheduled") continue;
      await this.write({
        ...record,
        deliveryState: "pending",
        scheduledAt: undefined,
        deliveryBatchId: undefined,
      });
    }
  }

  async claimPending(
    maximumRecords = MAX_BATCH_RECORDS,
    maximumChars = MAX_BATCH_CHARS,
  ): Promise<ScheduledBatch | undefined> {
    const candidates = (await this.list()).filter(
      (record) => record.deliveryState === "pending",
    );
    const records: CompletionInboxRecord[] = [];
    let length = "Worker completion inbox:".length;
    for (const record of candidates) {
      const nextLength = length + record.handoff.length + 2;
      if (records.length > 0 && nextLength > maximumChars) break;
      records.push(record);
      length = nextLength;
      if (records.length === maximumRecords) break;
    }
    if (records.length === 0) return undefined;

    const id = randomUUID();
    const scheduledAt = new Date().toISOString();
    const scheduled = records.map((record) => ({
      ...record,
      deliveryState: "scheduled" as const,
      scheduledAt,
      deliveryBatchId: id,
    }));
    await Promise.all(scheduled.map((record) => this.write(record)));
    return { id, records: scheduled };
  }

  async release(batch: ScheduledBatch): Promise<void> {
    for (const record of batch.records) {
      const current = await this.readById(record.id);
      if (
        !current ||
        current.deliveryState !== "scheduled" ||
        current.deliveryBatchId !== batch.id
      ) {
        continue;
      }
      await this.write({
        ...current,
        deliveryState: "pending",
        scheduledAt: undefined,
        deliveryBatchId: undefined,
      });
    }
  }

  async acknowledge(batchId: string, recordIds: string[]): Promise<number> {
    let acknowledged = 0;
    for (const id of recordIds) {
      const record = await this.readById(id);
      if (
        !record ||
        record.deliveryState !== "scheduled" ||
        record.deliveryBatchId !== batchId
      ) {
        continue;
      }
      await this.write({
        ...record,
        deliveryState: "acknowledged",
        acknowledgedAt: new Date().toISOString(),
      });
      acknowledged++;
    }
    return acknowledged;
  }

  async consume(recordIds: string[]): Promise<CompletionInboxRecord[]> {
    const consumed: CompletionInboxRecord[] = [];
    for (const id of recordIds) {
      const record = await this.readById(id);
      if (!record || record.deliveryState === "consumed") continue;
      const next: CompletionInboxRecord = {
        ...record,
        deliveryState: "consumed",
        consumedAt: new Date().toISOString(),
      };
      await this.write(next);
      consumed.push(next);
    }
    return consumed;
  }

  private async read(name: string): Promise<CompletionInboxRecord | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.directory, name), "utf8"),
      );
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private readById(id: string): Promise<CompletionInboxRecord | undefined> {
    return this.read(`${id}.json`);
  }

  private async write(record: CompletionInboxRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${record.id}.json`);
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }
}

export class CompletionInboxDelivery {
  private readonly pi: Pick<ExtensionAPI, "sendMessage">;
  private readonly inbox: CompletionInbox;
  private scheduling?: Promise<boolean>;

  constructor(pi: Pick<ExtensionAPI, "sendMessage">, inbox: CompletionInbox) {
    this.pi = pi;
    this.inbox = inbox;
  }

  schedule(): Promise<boolean> {
    if (!this.scheduling) {
      this.scheduling = this.scheduleNext().finally(() => {
        this.scheduling = undefined;
      });
    }
    return this.scheduling;
  }

  async acknowledgeMessage(message: AgentMessage): Promise<number> {
    const details = inboxMessageDetails(message);
    if (!details) return 0;
    return this.inbox.acknowledge(details.batchId, details.recordIds);
  }

  private async scheduleNext(): Promise<boolean> {
    const batch = await this.inbox.claimPending();
    if (!batch) return false;
    try {
      this.pi.sendMessage(
        {
          customType: COMPLETION_INBOX_MESSAGE_TYPE,
          content: formatBatch(batch.records),
          display: true,
          details: {
            batchId: batch.id,
            recordIds: batch.records.map((record) => record.id),
          },
        },
        { deliverAs: "nextTurn" },
      );
      return true;
    } catch (error) {
      await this.inbox.release(batch);
      throw error;
    }
  }
}

function formatBatch(records: CompletionInboxRecord[]): string {
  return [
    "Worker completion inbox:",
    ...records.map((record) => record.handoff),
  ]
    .join("\n\n")
    .slice(0, MAX_BATCH_CHARS);
}

function inboxMessageDetails(
  message: AgentMessage,
): { batchId: string; recordIds: string[] } | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "custom" ||
    message.customType !== COMPLETION_INBOX_MESSAGE_TYPE
  ) {
    return undefined;
  }
  const details = message.details;
  if (
    typeof details !== "object" ||
    details === null ||
    !("batchId" in details) ||
    !("recordIds" in details) ||
    typeof details.batchId !== "string" ||
    !Array.isArray(details.recordIds) ||
    !details.recordIds.every((id) => typeof id === "string")
  ) {
    return undefined;
  }
  return { batchId: details.batchId, recordIds: details.recordIds };
}

function isRecord(value: unknown): value is CompletionInboxRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "workstreamId" in value &&
    "terminalStatus" in value &&
    "handoff" in value &&
    "deliveryState" in value &&
    "createdAt" in value
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
