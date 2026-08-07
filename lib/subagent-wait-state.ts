export const SUBAGENT_WAIT_STATE_EVENT = "pi-tools:subagent-wait-state";

export type SubagentWaitStateEvent = {
  sessionId: string;
  toolCallId: string;
  phase: "started" | "ended";
};

export function isSubagentWaitStateEvent(
  value: unknown,
): value is SubagentWaitStateEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<SubagentWaitStateEvent>;
  return (
    typeof event.sessionId === "string" &&
    typeof event.toolCallId === "string" &&
    (event.phase === "started" || event.phase === "ended")
  );
}
