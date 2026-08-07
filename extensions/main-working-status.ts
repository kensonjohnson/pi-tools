import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  isSubagentWaitStateEvent,
  SUBAGENT_WAIT_STATE_EVENT,
} from "../lib/subagent-wait-state.ts";

export const WORKING_MESSAGE = "Working…";
export const WAITING_ON_WORKERS_MESSAGE = "Waiting on workers…";

/**
 * Owns only the main TUI's working text. Pi retains ownership of the row's
 * streaming visibility and stock spinner frames.
 */
export default function (pi: ExtensionAPI) {
  let active = false;
  let sessionId: string | undefined;
  let workingUI: Pick<ExtensionContext["ui"], "setWorkingMessage"> | undefined;
  const activeWaitToolCallIds = new Set<string>();

  const applyMessage = () => {
    workingUI?.setWorkingMessage(
      activeWaitToolCallIds.size > 0
        ? WAITING_ON_WORKERS_MESSAGE
        : WORKING_MESSAGE,
    );
  };

  pi.events.on(SUBAGENT_WAIT_STATE_EVENT, (event) => {
    if (!active || !isSubagentWaitStateEvent(event)) return;
    if (event.sessionId !== sessionId) return;
    if (event.phase === "started") {
      activeWaitToolCallIds.add(event.toolCallId);
    } else {
      activeWaitToolCallIds.delete(event.toolCallId);
    }
    applyMessage();
  });

  pi.on("session_start", (_event, ctx) => {
    active = ctx.hasUI && ctx.mode === "tui";
    activeWaitToolCallIds.clear();
    sessionId = active ? ctx.sessionManager.getSessionId() : undefined;
    workingUI = active ? ctx.ui : undefined;
    if (active) applyMessage();
  });

  pi.on("session_shutdown", () => {
    workingUI?.setWorkingMessage();
    active = false;
    sessionId = undefined;
    workingUI = undefined;
    activeWaitToolCallIds.clear();
  });
}
