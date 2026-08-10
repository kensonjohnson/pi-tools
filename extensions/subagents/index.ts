import { relative } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  type ImageContent,
  type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { publishExtensionSettings } from "../../lib/pi-tools-config.ts";
import {
  isExtensionEnabled,
  removeDisabledTools,
} from "../../lib/pi-tools-runtime-settings.ts";
import {
  SUBAGENTS_EXTENSION_ID,
  SUBAGENT_SETTINGS,
  SUBAGENT_TOOL_NAMES,
} from "./settings.ts";
import {
  renderResearchTimelineEntry,
  ResearchWorkstreamService,
} from "./research-workstreams.ts";
import { registerResearchWorkstreamTools } from "./research-tools.ts";
import {
  renderTaskControlTimelineEntry,
  renderTaskTimelineEntry,
  TaskWorkstreamService,
} from "./task-workstreams.ts";
import { registerTaskWorkstreamTools } from "./task-tools.ts";
import {
  resolveSubagentDelegationMode,
  resolveSubagentOutputTailLines,
} from "./launch-policy.ts";
import {
  CompletionInbox,
  CompletionInboxDelivery,
} from "./completion-inbox.ts";
import { type WorkstreamEvent, WorkstreamSupervisor } from "./supervisor.ts";
import { registerSubagentWaitTool, SubagentWaitService } from "./wait-tools.ts";

type DeferredUserInput = {
  text: string;
  images?: ImageContent[];
};

export const WAITING_ON_WORKERS_MESSAGE =
  "Waiting on workers… You can still send a message.";

const PROACTIVE_DELEGATION_GUIDANCE = `
## Proactive subagent delegation

Use the available subagent tools proactively during ordinary work: independently launch a task worker or research job when a clearly bounded, useful subproblem can proceed in parallel, such as repository investigation, external research, test reproduction, or a separable implementation slice. Do not wait for the user to request a worker and do not delegate merely because capacity exists.

Advisory default: delegate every repository implementation change to a task worker, regardless of origin. Reserve direct main-agent work for answering, planning, and non-repository actions. This is advisory guidance, not a hard enforcement, and does not require delegating consequential external operations.

Delegation preserves main-agent context by isolating detailed investigation, tool output, and implementation/debug churn in worker sessions. Receive only concise, bounded handoffs relevant to integration and acceptance decisions, not detailed transcripts.

The main agent is the primary orchestrator: choose and coordinate workers, decide when to wait for or synthesize their results, integrate work, verify acceptance, and own the user relationship and final decisions. Workers execute bounded delegated work and do not own the user relationship or final decisions.

Keep ownership of user intent, integration, consequential decisions, and acceptance. Give workers a narrow objective and scope, honor the shared concurrency cap, and use their bounded handoffs rather than importing detailed worker transcripts. Never delegate consequential external operations; stop and report those needs instead.
`.trim();

export function scheduleTerminalCompletionDelivery(
  event: Pick<WorkstreamEvent, "type">,
  schedule: (() => Promise<boolean>) | undefined,
): Promise<boolean> | undefined {
  if (
    !schedule ||
    (event.type !== "settled" &&
      event.type !== "blocked" &&
      event.type !== "needs_decision")
  ) {
    return undefined;
  }
  return schedule();
}

export default function (pi: ExtensionAPI) {
  let supervisor: WorkstreamSupervisor | undefined;
  let tasks: TaskWorkstreamService | undefined;
  let research: ResearchWorkstreamService | undefined;
  let inbox: CompletionInbox | undefined;
  let inboxDelivery: CompletionInboxDelivery | undefined;
  let scheduleCompletionDelivery: (() => Promise<boolean>) | undefined;
  let wait: SubagentWaitService | undefined;
  let delegationMode: "manual" | "proactive" = "manual";
  let sessionActive = false;
  // Keep intercepting through abort unwinding after the wait tool itself ends.
  let waitAbortPending = false;
  let waitMessageUI:
    Pick<ExtensionContext["ui"], "setWorkingMessage"> | undefined;
  const activeWaitToolCallIds = new Set<string>();
  // One replay per settled turn preserves interactive/RPC input order.
  const deferredUserInputs: DeferredUserInput[] = [];

  publishExtensionSettings(pi.events, SUBAGENT_SETTINGS);
  registerTaskWorkstreamTools(pi, () => tasks);
  registerResearchWorkstreamTools(pi, () => research);
  registerSubagentWaitTool(pi, () => wait);
  pi.registerEntryRenderer(
    "pi-tools:subagent-task-timeline",
    renderTaskTimelineEntry,
  );
  pi.registerEntryRenderer(
    "pi-tools:subagent-task-control-timeline",
    renderTaskControlTimelineEntry,
  );
  pi.registerEntryRenderer(
    "pi-tools:subagent-research-timeline",
    renderResearchTimelineEntry,
  );

  pi.on("session_start", async (_event, ctx) => {
    sessionActive = false;
    waitAbortPending = false;
    waitMessageUI = undefined;
    activeWaitToolCallIds.clear();
    deferredUserInputs.length = 0;
    const workerSession = isSubagentWorkerSession(ctx);
    const enabled =
      !workerSession &&
      ctx.isProjectTrusted() &&
      (await isExtensionEnabled(ctx, CONFIG_DIR_NAME, SUBAGENTS_EXTENSION_ID));
    removeDisabledTools(pi, SUBAGENT_TOOL_NAMES, enabled);
    supervisor = undefined;
    tasks = undefined;
    research = undefined;
    inbox = undefined;
    inboxDelivery = undefined;
    scheduleCompletionDelivery = undefined;
    wait = undefined;
    delegationMode = "manual";
    if (!enabled) return;
    sessionActive = true;
    waitMessageUI = ctx.hasUI && ctx.mode === "tui" ? ctx.ui : undefined;
    delegationMode = await resolveSubagentDelegationMode(ctx);
    const outputTailLines = await resolveSubagentOutputTailLines(ctx);

    supervisor = new WorkstreamSupervisor({
      cwd: ctx.cwd,
      onEvent: (event) => {
        // Routine state remains in the widget and durable journal. Terminal
        // completion records are already durable when this fires, so an active
        // parent can receive their bounded handoff at its current turn boundary.
        void tasks?.refreshWidget(ctx);
        void scheduleTerminalCompletionDelivery(
          event,
          scheduleCompletionDelivery,
        )?.catch(() => {});
      },
    });
    inbox = new CompletionInbox(supervisor.rootDirectory);
    await inbox.recoverScheduled();
    inboxDelivery = new CompletionInboxDelivery(pi, inbox);
    scheduleCompletionDelivery = () => {
      // A live wait atomically consumes its own snapshot reports. Do not queue
      // an overlapping custom message that would duplicate that tool result.
      if (activeWaitToolCallIds.size > 0) return Promise.resolve(false);
      return (
        inboxDelivery?.schedule(() => (ctx.isIdle() ? "nextTurn" : "steer")) ??
        Promise.resolve(false)
      );
    };
    wait = new SubagentWaitService(supervisor, inbox, async () => {
      await tasks?.refreshWidget(ctx);
    });
    tasks = new TaskWorkstreamService(
      pi,
      supervisor,
      ctx.cwd,
      inbox,
      outputTailLines,
    );
    research = new ResearchWorkstreamService(
      pi,
      supervisor,
      tasks,
      ctx.cwd,
      inbox,
    );
    await supervisor.recoverInterrupted();
    await tasks.refreshWidget(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (
      sessionActive &&
      !isSubagentWorkerSession(ctx) &&
      event.toolName === "subagent_wait"
    ) {
      activeWaitToolCallIds.add(event.toolCallId);
      waitMessageUI?.setWorkingMessage(WAITING_ON_WORKERS_MESSAGE);
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (
      !isSubagentWorkerSession(ctx) &&
      activeWaitToolCallIds.delete(event.toolCallId)
    ) {
      if (activeWaitToolCallIds.size === 0) {
        waitMessageUI?.setWorkingMessage();
        // A cancelled wait leaves records untouched; once it exits, deliver
        // any completion that was deliberately held to avoid a duplicate.
        void scheduleCompletionDelivery?.().catch(() => {});
      }
    }
  });

  pi.on("input", (event, ctx) => {
    if (
      !shouldInterruptWait(
        event,
        ctx,
        sessionActive,
        waitAbortPending,
        activeWaitToolCallIds,
      )
    ) {
      return;
    }
    deferredUserInputs.push({
      text: event.text,
      images: event.images ? [...event.images] : undefined,
    });
    waitAbortPending = true;
    ctx.abort();
    return { action: "handled" };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!sessionActive || isSubagentWorkerSession(ctx)) return;
    waitAbortPending = false;
    await scheduleCompletionDelivery?.();
    await tasks?.refreshWidget(ctx);
    replayNextDeferredUserInput(
      pi,
      ctx,
      deferredUserInputs,
      () => sessionActive,
    );
  });

  pi.on("message_end", async (event, ctx) => {
    if (!inboxDelivery || isSubagentWorkerSession(ctx)) return;
    if (await inboxDelivery.acknowledgeMessage(event.message)) {
      await tasks?.refreshWidget(ctx);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (
      delegationMode !== "proactive" ||
      !ctx.isProjectTrusted() ||
      isSubagentWorkerSession(ctx)
    ) {
      return;
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${PROACTIVE_DELEGATION_GUIDANCE}`,
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    waitMessageUI?.setWorkingMessage();
    sessionActive = false;
    waitAbortPending = false;
    waitMessageUI = undefined;
    activeWaitToolCallIds.clear();
    deferredUserInputs.length = 0;
    await supervisor?.shutdown();
    tasks?.clearWidget(ctx);
    supervisor = undefined;
    tasks = undefined;
    research = undefined;
    inbox = undefined;
    inboxDelivery = undefined;
    scheduleCompletionDelivery = undefined;
    wait = undefined;
    delegationMode = "manual";
  });
}

function shouldInterruptWait(
  event: InputEvent,
  ctx: ExtensionContext,
  sessionActive: boolean,
  waitAbortPending: boolean,
  activeWaitToolCallIds: ReadonlySet<string>,
): boolean {
  return (
    sessionActive &&
    (activeWaitToolCallIds.size > 0 || waitAbortPending) &&
    (event.source === "interactive" || event.source === "rpc") &&
    event.streamingBehavior !== undefined &&
    !ctx.isIdle() &&
    !isSubagentWorkerSession(ctx)
  );
}

function replayNextDeferredUserInput(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: Pick<ExtensionContext, "isIdle">,
  deferredUserInputs: DeferredUserInput[],
  isSessionActive: () => boolean,
): void {
  if (!isSessionActive() || deferredUserInputs.length === 0 || !ctx.isIdle()) {
    return;
  }
  const input = deferredUserInputs.shift();
  if (!input) return;
  const content = input.images?.length
    ? [{ type: "text" as const, text: input.text }, ...input.images]
    : input.text;
  pi.sendUserMessage(content);
}

export function isSubagentWorkerSession(
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): boolean {
  const sessionDirectory = ctx.sessionManager?.getSessionDir?.();
  if (!sessionDirectory) return false;
  const subagentRoot = `${ctx.cwd}/tmp/subagents`;
  const path = relative(subagentRoot, sessionDirectory);
  return path === "session" || (!path.startsWith("..") && !path.includes(".."));
}

export { PROACTIVE_DELEGATION_GUIDANCE };
