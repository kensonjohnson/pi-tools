import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_WAIT_STATE_EVENT,
  type SubagentWaitStateEvent,
} from "../../lib/subagent-wait-state.ts";
import extension, {
  WAITING_ON_WORKERS_MESSAGE,
  WORKING_MESSAGE,
} from "../main-working-status.ts";

type Handler = (event: unknown, ctx: any) => unknown;

function createExtensionHarness() {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Array<(event: unknown) => void>>();
  const messages: Array<string | undefined> = [];
  const pi = {
    events: {
      emit(channel: string, event: unknown) {
        for (const handler of eventHandlers.get(channel) ?? []) handler(event);
      },
      on(channel: string, handler: (event: unknown) => void) {
        const handlers = eventHandlers.get(channel) ?? [];
        handlers.push(handler);
        eventHandlers.set(channel, handlers);
        return () =>
          eventHandlers.set(
            channel,
            handlers.filter((h) => h !== handler),
          );
      },
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  extension(pi as unknown as ExtensionAPI);
  return {
    handlers,
    messages,
    pi,
    ui: {
      setWorkingMessage(message?: string) {
        messages.push(message);
      },
    },
  };
}

function waitEvent(
  sessionId: string,
  toolCallId: string,
  phase: SubagentWaitStateEvent["phase"],
): SubagentWaitStateEvent {
  return { sessionId, toolCallId, phase };
}

test("main TUI switches working text only for its own active waits", () => {
  const { handlers, messages, pi, ui } = createExtensionHarness();
  const ctx = {
    hasUI: true,
    mode: "tui",
    sessionManager: { getSessionId: () => "main-session" },
    ui,
  };

  handlers.get("session_start")?.({}, ctx);
  assert.deepEqual(messages, [WORKING_MESSAGE]);

  pi.events.emit(
    SUBAGENT_WAIT_STATE_EVENT,
    waitEvent("worker-session", "wait-1", "started"),
  );
  assert.deepEqual(messages, [WORKING_MESSAGE]);

  pi.events.emit(
    SUBAGENT_WAIT_STATE_EVENT,
    waitEvent("main-session", "wait-1", "started"),
  );
  pi.events.emit(
    SUBAGENT_WAIT_STATE_EVENT,
    waitEvent("main-session", "wait-2", "started"),
  );
  assert.deepEqual(messages, [
    WORKING_MESSAGE,
    WAITING_ON_WORKERS_MESSAGE,
    WAITING_ON_WORKERS_MESSAGE,
  ]);

  pi.events.emit(
    SUBAGENT_WAIT_STATE_EVENT,
    waitEvent("main-session", "wait-1", "ended"),
  );
  assert.equal(messages.at(-1), WAITING_ON_WORKERS_MESSAGE);
  pi.events.emit(
    SUBAGENT_WAIT_STATE_EVENT,
    waitEvent("main-session", "wait-2", "ended"),
  );
  assert.equal(messages.at(-1), WORKING_MESSAGE);

  handlers.get("session_shutdown")?.({}, ctx);
  assert.equal(messages.at(-1), undefined);
});

test("headless and RPC sessions do not own the working row", () => {
  for (const ctx of [
    {
      hasUI: false,
      mode: "print",
      sessionManager: { getSessionId: () => "headless-session" },
    },
    {
      hasUI: true,
      mode: "rpc",
      sessionManager: { getSessionId: () => "rpc-session" },
    },
  ]) {
    const { handlers, messages, pi, ui } = createExtensionHarness();
    handlers.get("session_start")?.({}, { ...ctx, ui });
    pi.events.emit(
      SUBAGENT_WAIT_STATE_EVENT,
      waitEvent(ctx.sessionManager.getSessionId(), "wait-1", "started"),
    );
    assert.deepEqual(messages, []);
  }
});
