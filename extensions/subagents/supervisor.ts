import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { SubagentLaunchPolicy } from "./launch-policy.ts";
import type { SubagentWorkstreamKind } from "./settings.ts";

const execFileAsync = promisify(execFile);
const WORKSTREAM_SCHEMA_VERSION = 1;

export type WorkstreamStatus =
  | "starting"
  | "running"
  | "settled"
  | "blocked"
  | "needs_decision"
  | "failed"
  | "paused"
  | "cancelled";

export type GitObservation = {
  branch?: string;
  commit?: string;
};

export type WorkstreamRecovery = {
  checkpointAt: string;
  reason: string;
  workerSessionFile?: string;
  journalTail: string[];
};

export type WorkstreamManifest = {
  version: number;
  id: string;
  kind: SubagentWorkstreamKind;
  status: WorkstreamStatus;
  brief: string;
  createdAt: string;
  updatedAt: string;
  workerSessionDirectory: string;
  workerSessionFile?: string;
  linkedTaskWorkstreamId?: string;
  git: GitObservation;
  recovery?: WorkstreamRecovery;
  failure?: string;
};

export type WorkstreamProgressEvent = {
  id: string;
  kind: "thinking" | "tool";
  state: "active" | "complete" | "success" | "failed";
  text: string;
};

export type WorkstreamEvent = {
  workstreamId: string;
  type:
    | "progress"
    | "started"
    | "tool_started"
    | "tool_finished"
    | "settled"
    | "blocked"
    | "needs_decision"
    | "follow_up"
    | "delivered"
    | "redirected"
    | "checkpoint"
    | "resumed"
    | "cancelled"
    | "failed"
    | "paused";
  status: WorkstreamStatus;
  at: string;
};

export type WorkerSession = Pick<
  AgentSession,
  | "sessionFile"
  | "messages"
  | "subscribe"
  | "prompt"
  | "steer"
  | "followUp"
  | "abort"
  | "dispose"
>;

export type WorkerSessionFactoryOptions = {
  cwd: string;
  sessionDirectory: string;
  resumeSessionFile?: string;
  model: SubagentLaunchPolicy["model"];
  roleContract: string;
};

export type WorkerSessionFactory = (
  options: WorkerSessionFactoryOptions,
) => Promise<WorkerSession>;

export type WorkstreamCompletion = {
  status?: Extract<WorkstreamStatus, "settled" | "blocked" | "needs_decision">;
  detail?: string;
};

export type WorkstreamCompletionHandler = (input: {
  manifest: WorkstreamManifest;
  session: WorkerSession;
}) => Promise<WorkstreamCompletion | void> | WorkstreamCompletion | void;

export type WorkstreamSupervisorOptions = {
  cwd: string;
  rootDirectory?: string;
  createSession?: WorkerSessionFactory;
  observeGit?: (cwd: string) => Promise<GitObservation>;
  onEvent?: (event: WorkstreamEvent) => void;
  onCompletion?: WorkstreamCompletionHandler;
};

export type LaunchWorkstreamInput = {
  kind: SubagentWorkstreamKind;
  brief: string;
  linkedTaskWorkstreamId?: string;
  policy: SubagentLaunchPolicy;
};

export const WORKER_ROLE_CONTRACT = `
You are a delegated Pi worker operating in a trusted local repository.

- Work only on the purpose-built brief supplied by the parent agent.
- You may inspect, edit, test, build, and research locally as needed.
- Do not perform consequential external operations: remote Git actions, deployment, infrastructure or production-data changes, spending, publishing, or communication. Stop and report the need to the parent agent instead.
- Keep status updates and final results concise. State what you changed or found, verification performed, blockers, and the next action.
- The parent agent owns user intent, consequential decisions, and acceptance; do not make those decisions independently.
`.trim();

export const RESEARCH_WORKER_ROLE_CONTRACT = `
${WORKER_ROLE_CONTRACT}

You are a fire-and-forget research worker. Use non-mutating inspection and research tools only; do not edit repository files, run mutating commands, or perform external actions. Retain source URLs, titles, and evidence notes in your final structured research report. Separate evidence from inference and report uncertainty or a blocker rather than guessing.
`.trim();

export async function createPiWorkerSession(
  options: WorkerSessionFactoryOptions,
): Promise<WorkerSession> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  // Workers deliberately do not retry or restart themselves. This override is
  // in-memory and does not modify the user's Pi settings.
  settingsManager.applyOverrides({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    appendSystemPromptOverride: (base) => [...base, options.roleContract],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    model: options.model.model,
    thinkingLevel: options.model.thinkingLevel,
    resourceLoader,
    sessionManager: options.resumeSessionFile
      ? SessionManager.open(
          options.resumeSessionFile,
          options.sessionDirectory,
          options.cwd,
        )
      : SessionManager.create(options.cwd, options.sessionDirectory),
    settingsManager,
  });
  return session;
}

export class WorkstreamSupervisor {
  private readonly cwd: string;
  readonly rootDirectory: string;
  private readonly createSession: WorkerSessionFactory;
  private readonly observeGit: (cwd: string) => Promise<GitObservation>;
  private readonly onEvent?: (event: WorkstreamEvent) => void;
  private readonly completionHandlers: WorkstreamCompletionHandler[] = [];
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly activeWorkstreams = new Set<string>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly progress = new Map<string, WorkstreamProgressEvent[]>();

  constructor(options: WorkstreamSupervisorOptions) {
    this.cwd = options.cwd;
    this.rootDirectory =
      options.rootDirectory ?? join(options.cwd, "tmp", "subagents");
    this.createSession = options.createSession ?? createPiWorkerSession;
    this.observeGit = options.observeGit ?? observeGit;
    this.onEvent = options.onEvent;
    if (options.onCompletion)
      this.completionHandlers.push(options.onCompletion);
  }

  setCompletionHandler(handler: WorkstreamCompletionHandler | undefined): void {
    this.completionHandlers.length = 0;
    if (handler) this.completionHandlers.push(handler);
  }

  addCompletionHandler(handler: WorkstreamCompletionHandler): void {
    this.completionHandlers.push(handler);
  }

  async launch(input: LaunchWorkstreamInput): Promise<WorkstreamManifest> {
    if (this.runningCount() >= input.policy.maxConcurrentWorkers) {
      throw new Error(
        `Subagent concurrency limit (${input.policy.maxConcurrentWorkers}) is reached; no worker was started.`,
      );
    }

    const id = randomUUID();
    const workstreamDirectory = join(this.rootDirectory, id);
    const workerSessionDirectory = join(workstreamDirectory, "session");
    const now = new Date().toISOString();
    const manifest: WorkstreamManifest = {
      version: WORKSTREAM_SCHEMA_VERSION,
      id,
      kind: input.kind,
      status: "starting",
      brief: input.brief,
      ...(input.linkedTaskWorkstreamId
        ? { linkedTaskWorkstreamId: input.linkedTaskWorkstreamId }
        : {}),
      createdAt: now,
      updatedAt: now,
      workerSessionDirectory,
      git: await this.observeGit(this.cwd),
    };
    await this.createWorkstream(manifest);
    this.activeWorkstreams.add(id);

    let session: WorkerSession;
    try {
      session = await this.createSession({
        cwd: this.cwd,
        sessionDirectory: workerSessionDirectory,
        model: input.policy.model,
        roleContract: roleContractFor(input.kind),
      });
    } catch (error) {
      this.activeWorkstreams.delete(id);
      return this.transition(
        manifest.id,
        "failed",
        "failed",
        errorMessage(error),
      );
    }

    this.sessions.set(id, session);
    session.subscribe((event) => this.handleSessionEvent(id, event));
    const running = await this.transition(
      id,
      "running",
      "started",
      undefined,
      session.sessionFile,
    );

    this.startRun(id, session, input.brief);
    return running;
  }

  async get(id: string): Promise<WorkstreamManifest | undefined> {
    return this.readManifest(id);
  }

  async isLive(id: string): Promise<boolean> {
    const manifest = await this.readManifest(id);
    return Boolean(
      manifest?.status === "running" &&
      this.activeWorkstreams.has(id) &&
      this.sessions.has(id),
    );
  }

  progressEvents(id: string): readonly WorkstreamProgressEvent[] {
    return this.progress.get(id) ?? [];
  }

  async list(): Promise<WorkstreamManifest[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDirectory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const manifests = await Promise.all(
      entries.map((id) => this.readManifest(id)),
    );
    return manifests.filter((manifest): manifest is WorkstreamManifest =>
      Boolean(manifest),
    );
  }

  async markBlocked(id: string, reason: string): Promise<WorkstreamManifest> {
    return this.transition(id, "blocked", "blocked", reason);
  }

  async markNeedsDecision(
    id: string,
    reason: string,
  ): Promise<WorkstreamManifest> {
    return this.transition(id, "needs_decision", "needs_decision", reason);
  }

  async followUp(id: string, prompt: string): Promise<WorkstreamManifest> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(
        `Task worker '${id}' is unavailable in this Pi session; explicitly resume it before sending a focused follow-up.`,
      );
    }
    const manifest = await this.requireManifest(id);
    if (manifest.status === "paused") {
      throw new Error(
        `Task worker '${id}' is paused; explicitly resume it first.`,
      );
    }
    if (manifest.status === "cancelled") {
      throw new Error(
        `Task worker '${id}' was cancelled and cannot be resumed.`,
      );
    }
    if (this.activeWorkstreams.has(id)) {
      await session.followUp(prompt);
      await this.recordRoutineEvent(
        id,
        "follow_up",
        "Focused follow-up queued.",
      );
      return this.requireManifest(id);
    }

    this.activeWorkstreams.add(id);
    const running = await this.transition(
      id,
      "running",
      "started",
      "Focused follow-up started.",
    );
    this.startRun(id, session, prompt);
    return running;
  }

  async recordDelivery(
    id: string,
    detail: string,
  ): Promise<WorkstreamManifest> {
    await this.recordRoutineEvent(id, "delivered", detail);
    return this.requireManifest(id);
  }

  async redirect(id: string, prompt: string): Promise<WorkstreamManifest> {
    const manifest = await this.requireManifest(id);
    const session = this.sessions.get(id);
    if (
      !session ||
      !this.activeWorkstreams.has(id) ||
      manifest.status !== "running"
    ) {
      throw new Error(
        `Task worker '${id}' is not running and cannot be redirected.`,
      );
    }
    await session.steer(prompt);
    await this.recordRoutineEvent(
      id,
      "redirected",
      `Parent redirect queued: ${boundDetail(prompt)}`,
    );
    return this.requireManifest(id);
  }

  async checkpoint(
    id: string,
    reason = "Checkpoint requested by the parent agent.",
  ): Promise<WorkstreamManifest> {
    return this.enqueue(id, async () => {
      const manifest = await this.requireManifest(id);
      if (manifest.status === "cancelled") {
        throw new Error(
          `Task worker '${id}' was cancelled and has no resumable checkpoint.`,
        );
      }
      const at = new Date().toISOString();
      const recovery: WorkstreamRecovery = {
        checkpointAt: at,
        reason: boundDetail(reason),
        ...(manifest.workerSessionFile
          ? { workerSessionFile: manifest.workerSessionFile }
          : {}),
        journalTail: await this.readJournalTail(id),
      };
      const next: WorkstreamManifest = {
        ...manifest,
        updatedAt: at,
        recovery,
      };
      await this.writeManifest(next);
      await this.appendJournal(id, at, "checkpoint", reason);
      this.onEvent?.({
        workstreamId: id,
        type: "checkpoint",
        status: next.status,
        at,
      });
      return next;
    });
  }

  async pause(
    id: string,
    reason = "Paused by the parent agent.",
  ): Promise<WorkstreamManifest> {
    const manifest = await this.requireManifest(id);
    if (manifest.status === "cancelled") {
      throw new Error(
        `Task worker '${id}' was cancelled and cannot be paused.`,
      );
    }
    if (manifest.status === "paused") return manifest;
    await this.checkpoint(id, reason);
    const current = await this.requireManifest(id);
    if (current.status !== "starting" && current.status !== "running") {
      throw new Error(
        `Task worker '${id}' is ${current.status} and cannot be paused.`,
      );
    }
    const paused = await this.transition(id, "paused", "paused", reason);
    const session = this.sessions.get(id);
    if (session) {
      try {
        await session.abort();
      } finally {
        this.activeWorkstreams.delete(id);
      }
    }
    return paused;
  }

  async cancel(
    id: string,
    reason = "Cancelled by the parent agent.",
  ): Promise<WorkstreamManifest> {
    const manifest = await this.requireManifest(id);
    if (manifest.status === "cancelled") return manifest;
    if (manifest.status === "settled") {
      throw new Error(
        `Task worker '${id}' has already settled and cannot be cancelled.`,
      );
    }
    const cancelled = await this.transition(
      id,
      "cancelled",
      "cancelled",
      reason,
    );
    const session = this.sessions.get(id);
    try {
      await session?.abort();
    } finally {
      session?.dispose();
      this.sessions.delete(id);
      this.activeWorkstreams.delete(id);
    }
    return cancelled;
  }

  async resume(
    id: string,
    policy: SubagentLaunchPolicy,
  ): Promise<WorkstreamManifest> {
    const manifest = await this.requireManifest(id);
    if (manifest.status === "cancelled") {
      throw new Error(
        `Task worker '${id}' was cancelled and cannot be resumed.`,
      );
    }
    if (manifest.status !== "paused") {
      throw new Error(
        `Task worker '${id}' is ${manifest.status}; only paused workstreams can resume.`,
      );
    }
    if (this.runningCount() >= policy.maxConcurrentWorkers) {
      throw new Error(
        `Subagent concurrency limit (${policy.maxConcurrentWorkers}) is reached; no worker was resumed.`,
      );
    }

    let session = this.sessions.get(id);
    if (!session) {
      if (!manifest.workerSessionFile) {
        throw new Error(
          `Task worker '${id}' has no persisted worker session to resume.`,
        );
      }
      session = await this.createSession({
        cwd: this.cwd,
        sessionDirectory: manifest.workerSessionDirectory,
        resumeSessionFile: manifest.workerSessionFile,
        model: policy.model,
        roleContract: roleContractFor(manifest.kind),
      });
      this.sessions.set(id, session);
      session.subscribe((event) => this.handleSessionEvent(id, event));
    }

    this.activeWorkstreams.add(id);
    const running = await this.transition(
      id,
      "running",
      "resumed",
      "Explicit resume started from the persisted worker session.",
      session.sessionFile,
    );
    this.startRun(id, session, buildResumeBrief(running));
    return running;
  }

  async recoverInterrupted(): Promise<WorkstreamManifest[]> {
    const manifests = await this.list();
    const recovered: WorkstreamManifest[] = [];
    for (const manifest of manifests) {
      if (manifest.status === "starting" || manifest.status === "running") {
        await this.checkpoint(
          manifest.id,
          "Recovered after the previous Pi session ended; explicit resume is required.",
        );
        recovered.push(
          await this.transition(
            manifest.id,
            "paused",
            "paused",
            "Recovered after the previous Pi session ended; explicit resume is required.",
          ),
        );
      }
    }
    return recovered;
  }

  async shutdown(): Promise<WorkstreamManifest[]> {
    const paused: WorkstreamManifest[] = [];
    const pausedIds = new Set<string>();
    for (const manifest of await this.list()) {
      if (manifest.status === "starting" || manifest.status === "running") {
        try {
          paused.push(
            await this.pause(
              manifest.id,
              "Pi session ended; explicit resume is required.",
            ),
          );
          pausedIds.add(manifest.id);
        } catch {
          // Continue shutting down the remaining live worker sessions. A later
          // trusted-session recovery scan will pause any interrupted manifest.
        }
      }
    }
    for (const [id, session] of this.sessions) {
      try {
        if (!pausedIds.has(id)) await session.abort();
      } catch {
        // Disposal still releases the in-process worker resource.
      }
      session.dispose();
      this.sessions.delete(id);
      this.activeWorkstreams.delete(id);
    }
    return paused;
  }

  async waitForSettlement(id: string): Promise<void> {
    await this.runs.get(id);
    await this.flush();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writes]);
  }

  private runningCount(): number {
    return this.activeWorkstreams.size;
  }

  private startRun(id: string, session: WorkerSession, prompt: string): void {
    const run = Promise.resolve()
      .then(() => session.prompt(prompt))
      .then(() => this.settleIfRunning(id))
      .catch((error) => this.failIfRunning(id, error));
    this.runs.set(id, run);
    void run.then(
      () => this.clearRun(id, run),
      () => this.clearRun(id, run),
    );
  }

  private clearRun(id: string, run: Promise<void>): void {
    // A resumed worker can begin a fresh run before an aborted predecessor's
    // promise unwinds. Only that run may release this worker's active slot.
    if (this.runs.get(id) !== run) return;
    this.runs.delete(id);
    this.activeWorkstreams.delete(id);
  }

  private handleSessionEvent(id: string, event: AgentSessionEvent): void {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "thinking_start") {
        this.recordProgress(id, {
          id: `thinking:${update.contentIndex}`,
          kind: "thinking",
          state: "active",
          text: "Thinking…",
        });
      } else if (update.type === "thinking_delta") {
        this.updateProgressText(
          id,
          `thinking:${update.contentIndex}`,
          update.delta,
        );
      } else if (update.type === "thinking_end") {
        this.finishProgress(id, `thinking:${update.contentIndex}`, "complete");
      }
      return;
    }

    let eventType: WorkstreamEvent["type"] | undefined;
    let journal: string | undefined;
    if (event.type === "tool_execution_start") {
      this.recordProgress(id, {
        id: `tool:${event.toolCallId}`,
        kind: "tool",
        state: "active",
        text: `Tool: ${event.toolName || "tool call"}`,
      });
      eventType = "tool_started";
      journal = `Worker started ${event.toolName || "a tool call"}.`;
    } else if (event.type === "tool_execution_end") {
      this.finishProgress(
        id,
        `tool:${event.toolCallId}`,
        event.isError ? "failed" : "success",
      );
      eventType = "tool_finished";
      journal = `Worker finished ${event.toolName || "a tool call"}.`;
    }
    if (!eventType || !journal) return;
    this.track(this.recordRoutineEvent(id, eventType, journal));
  }

  private recordProgress(id: string, event: WorkstreamProgressEvent): void {
    const events = this.progress.get(id) ?? [];
    events.push(event);
    this.progress.set(id, events.slice(-40));
    this.notifyProgress(id);
  }

  private updateProgressText(id: string, eventId: string, delta: string): void {
    const events = this.progress.get(id);
    const event = events?.find((entry) => entry.id === eventId);
    if (!event || !delta) return;
    const prior =
      event.text === "Thinking…" ? "" : event.text.replace(/^Thinking:\s*/, "");
    const text = boundDetail(`${prior}${delta}`);
    event.text = text ? `Thinking: ${text}` : "Thinking…";
    this.notifyProgress(id);
  }

  private finishProgress(
    id: string,
    eventId: string,
    state: Extract<
      WorkstreamProgressEvent["state"],
      "complete" | "success" | "failed"
    >,
  ): void {
    const event = this.progress.get(id)?.find((entry) => entry.id === eventId);
    if (!event) return;
    event.state = state;
    this.notifyProgress(id);
  }

  private notifyProgress(id: string): void {
    this.onEvent?.({
      workstreamId: id,
      type: "progress",
      status: "running",
      at: new Date().toISOString(),
    });
  }

  private async settleIfRunning(id: string): Promise<void> {
    const manifest = await this.readManifest(id);
    const session = this.sessions.get(id);
    if (!manifest || !session || manifest.status !== "running") return;

    let completion: WorkstreamCompletion | void;
    try {
      for (const handler of this.completionHandlers) {
        const result = await handler({ manifest, session });
        if (result !== undefined) {
          completion = result;
          break;
        }
      }
    } catch (error) {
      // A parent-side presentation failure must not restart or fail completed
      // worker execution. The durable worker session and journal remain intact.
      completion = {
        detail: `Completion handoff failed: ${errorMessage(error)}`,
      };
    }
    // A parent Stop/Cancel may have changed the state while the completion
    // handler retained an artifact. Never overwrite that deliberate action.
    const current = await this.readManifest(id);
    if (!current || current.status !== "running") return;
    const status = completion?.status ?? "settled";
    const eventType =
      status === "blocked"
        ? "blocked"
        : status === "needs_decision"
          ? "needs_decision"
          : "settled";
    await this.transition(
      id,
      status,
      eventType,
      completion?.detail ?? "Worker session settled.",
    );
  }

  private async failIfRunning(id: string, error: unknown): Promise<void> {
    const manifest = await this.readManifest(id);
    if (!manifest || manifest.status !== "running") return;
    await this.transition(id, "failed", "failed", errorMessage(error));
  }

  private async createWorkstream(manifest: WorkstreamManifest): Promise<void> {
    await mkdir(manifest.workerSessionDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await this.writeManifest(manifest);
    await appendFile(
      this.journalPath(manifest.id),
      `# ${manifest.kind} workstream ${manifest.id}\n\n[${manifest.createdAt}] starting: Workstream created.\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  private async transition(
    id: string,
    status: WorkstreamStatus,
    eventType: WorkstreamEvent["type"],
    detail: string | undefined,
    workerSessionFile?: string,
  ): Promise<WorkstreamManifest> {
    return this.enqueue(id, async () => {
      const manifest = await this.requireManifest(id);
      const at = new Date().toISOString();
      const next: WorkstreamManifest = {
        ...manifest,
        status,
        updatedAt: at,
        ...(workerSessionFile ? { workerSessionFile } : {}),
        ...(status === "failed"
          ? { failure: detail ?? "Worker session failed." }
          : {}),
      };
      await this.writeManifest(next);
      await this.appendJournal(id, at, eventType, detail);
      this.onEvent?.({ workstreamId: id, type: eventType, status, at });
      return next;
    });
  }

  private async recordRoutineEvent(
    id: string,
    eventType:
      | "tool_started"
      | "tool_finished"
      | "follow_up"
      | "delivered"
      | "redirected",
    detail: string,
  ): Promise<void> {
    await this.enqueue(id, async () => {
      const manifest = await this.requireManifest(id);
      const at = new Date().toISOString();
      await this.appendJournal(id, at, eventType, detail);
      this.onEvent?.({
        workstreamId: id,
        type: eventType,
        status: manifest.status,
        at,
      });
    });
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operationPromise = previous.catch(() => {}).then(operation);
    const queueTail = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, queueTail);
    void queueTail.finally(() => {
      if (this.queues.get(id) === queueTail) this.queues.delete(id);
    });
    this.track(operationPromise);
    return operationPromise;
  }

  private track(promise: Promise<unknown>): void {
    this.writes.add(promise);
    void promise.then(
      () => this.writes.delete(promise),
      () => this.writes.delete(promise),
    );
  }

  private async requireManifest(id: string): Promise<WorkstreamManifest> {
    const manifest = await this.readManifest(id);
    if (!manifest) throw new Error(`Unknown subagent workstream '${id}'.`);
    return manifest;
  }

  private async readManifest(
    id: string,
  ): Promise<WorkstreamManifest | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.manifestPath(id), "utf8"),
      ) as unknown;
      return isManifest(parsed) ? parsed : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async writeManifest(manifest: WorkstreamManifest): Promise<void> {
    const path = this.manifestPath(manifest.id);
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  private async appendJournal(
    id: string,
    at: string,
    eventType: WorkstreamEvent["type"],
    detail: string | undefined,
  ): Promise<void> {
    const bounded = detail ? boundDetail(detail) : "";
    await appendFile(
      this.journalPath(id),
      `[${at}] ${eventType}${bounded ? `: ${bounded}` : ""}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  private async readJournalTail(id: string): Promise<string[]> {
    try {
      return (await readFile(this.journalPath(id), "utf8"))
        .split("\n")
        .filter((line) => line.startsWith("["))
        .slice(-12)
        .map((line) => boundDetail(line));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private manifestPath(id: string): string {
    return join(this.rootDirectory, id, "manifest.json");
  }

  private journalPath(id: string): string {
    return join(this.rootDirectory, id, "journal.md");
  }
}

async function observeGit(cwd: string): Promise<GitObservation> {
  try {
    const [branch, commit] = await Promise.all([
      execFileAsync("git", ["branch", "--show-current"], { cwd }),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
    ]);
    return {
      ...(branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
      ...(commit.stdout.trim() ? { commit: commit.stdout.trim() } : {}),
    };
  } catch {
    return {};
  }
}

function roleContractFor(kind: SubagentWorkstreamKind): string {
  return kind === "research"
    ? RESEARCH_WORKER_ROLE_CONTRACT
    : WORKER_ROLE_CONTRACT;
}

function buildResumeBrief(manifest: WorkstreamManifest): string {
  const recovery = manifest.recovery;
  return [
    "# Explicit workstream resume",
    "Resume the existing worker session; do not reconstruct the parent transcript.",
    "",
    "## Original brief",
    manifest.brief,
    ...(recovery
      ? [
          "",
          "## Durable recovery checkpoint",
          `Recorded: ${recovery.checkpointAt}`,
          `Reason: ${recovery.reason}`,
          "Recent journal:",
          ...(recovery.journalTail.length > 0
            ? recovery.journalTail
            : ["No journal events were retained."]),
        ]
      : []),
    "",
    "Continue only from the retained worker context and this checkpoint. End with the required structured worker report.",
  ].join("\n");
}

function boundDetail(detail: string): string {
  return detail.replace(/\s+/g, " ").trim().slice(0, 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isManifest(value: unknown): value is WorkstreamManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "kind" in value &&
    "status" in value &&
    "workerSessionDirectory" in value
  );
}
