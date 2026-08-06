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
  | "failed"
  | "paused"
  | "cancelled";

export type GitObservation = {
  branch?: string;
  commit?: string;
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
  git: GitObservation;
  failure?: string;
};

export type WorkstreamEvent = {
  workstreamId: string;
  type:
    | "started"
    | "tool_started"
    | "tool_finished"
    | "settled"
    | "blocked"
    | "failed"
    | "paused";
  status: WorkstreamStatus;
  at: string;
};

export type WorkerSession = Pick<
  AgentSession,
  | "sessionFile"
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
  model: SubagentLaunchPolicy["model"];
  roleContract: string;
};

export type WorkerSessionFactory = (
  options: WorkerSessionFactoryOptions,
) => Promise<WorkerSession>;

export type WorkstreamSupervisorOptions = {
  cwd: string;
  rootDirectory?: string;
  createSession?: WorkerSessionFactory;
  observeGit?: (cwd: string) => Promise<GitObservation>;
  onEvent?: (event: WorkstreamEvent) => void;
};

export type LaunchWorkstreamInput = {
  kind: SubagentWorkstreamKind;
  brief: string;
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
    sessionManager: SessionManager.create(
      options.cwd,
      options.sessionDirectory,
    ),
    settingsManager,
  });
  return session;
}

export class WorkstreamSupervisor {
  private readonly cwd: string;
  private readonly rootDirectory: string;
  private readonly createSession: WorkerSessionFactory;
  private readonly observeGit: (cwd: string) => Promise<GitObservation>;
  private readonly onEvent?: (event: WorkstreamEvent) => void;
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly activeWorkstreams = new Set<string>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: WorkstreamSupervisorOptions) {
    this.cwd = options.cwd;
    this.rootDirectory =
      options.rootDirectory ?? join(options.cwd, "tmp", "subagents");
    this.createSession = options.createSession ?? createPiWorkerSession;
    this.observeGit = options.observeGit ?? observeGit;
    this.onEvent = options.onEvent;
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
        roleContract: WORKER_ROLE_CONTRACT,
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

    const run = Promise.resolve()
      .then(() => session.prompt(input.brief))
      .then(() => this.settleIfRunning(id))
      .catch((error) => this.failIfRunning(id, error));
    this.runs.set(id, run);
    void run.then(
      () => {
        this.runs.delete(id);
        this.activeWorkstreams.delete(id);
      },
      () => {
        this.runs.delete(id);
        this.activeWorkstreams.delete(id);
      },
    );
    return running;
  }

  async get(id: string): Promise<WorkstreamManifest | undefined> {
    return this.readManifest(id);
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

  async pause(
    id: string,
    reason = "Paused by the parent agent.",
  ): Promise<WorkstreamManifest> {
    return this.transition(id, "paused", "paused", reason);
  }

  async recoverInterrupted(): Promise<WorkstreamManifest[]> {
    const manifests = await this.list();
    const recovered: WorkstreamManifest[] = [];
    for (const manifest of manifests) {
      if (manifest.status === "starting" || manifest.status === "running") {
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

  private handleSessionEvent(id: string, event: AgentSessionEvent): void {
    let eventType: WorkstreamEvent["type"] | undefined;
    let journal: string | undefined;
    if (event.type === "tool_execution_start") {
      eventType = "tool_started";
      journal = "Worker started a tool call.";
    } else if (event.type === "tool_execution_end") {
      eventType = "tool_finished";
      journal = "Worker finished a tool call.";
    }
    if (!eventType || !journal) return;
    this.track(this.recordRoutineEvent(id, eventType, journal));
  }

  private async settleIfRunning(id: string): Promise<void> {
    const manifest = await this.readManifest(id);
    if (!manifest || manifest.status !== "running") return;
    await this.transition(id, "settled", "settled", "Worker session settled.");
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
    eventType: "tool_started" | "tool_finished",
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
    const bounded = detail ? detail.replace(/\s+/g, " ").slice(0, 500) : "";
    await appendFile(
      this.journalPath(id),
      `[${at}] ${eventType}${bounded ? `: ${bounded}` : ""}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
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
