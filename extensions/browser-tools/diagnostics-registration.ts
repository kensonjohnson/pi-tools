import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { BrowserDiagnostics } from "./diagnostics.ts";

export const DIAGNOSTIC_TOOL_NAMES = [
  "browser_diagnostics",
  "browser_diagnostic_body",
  "browser_diagnostic_headers",
] as const;

/**
 * Registers staged tools only; caller owns activation/trust gating and returns its current
 * session-local collector from getDiagnostics. Integrator must attach authorized pages
 * before navigation, detach them on tab close, and shut down the collector on session end.
 */
export function registerDiagnosticTools(
  pi: ExtensionAPI,
  getDiagnostics: () => BrowserDiagnostics,
  artifactScope?: (
    ctx: ExtensionContext | undefined,
    signal?: AbortSignal,
  ) => { owner: string; signal?: AbortSignal },
  authorize?: (
    target: { sessionId: string; tabId: string },
    ctx: ExtensionContext | undefined,
  ) => void,
): void {
  const target = {
    sessionId: Type.String({ minLength: 1, maxLength: 256 }),
    tabId: Type.String({ minLength: 1, maxLength: 256 }),
  };
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: undefined,
  });
  pi.registerTool({
    name: "browser_diagnostics",
    label: "Browser diagnostics",
    description:
      "Read or clear bounded page console and network history. For incremental reads pass the previous nextSequence as afterSequence; null means output was omitted and filters must be narrowed. Console text may contain secrets; body contents require explicit inspection.",
    parameters: Type.Object({
      ...target,
      action: Type.Union([Type.Literal("read"), Type.Literal("clear")]),
      since: Type.Optional(Type.Number()),
      level: Type.Optional(Type.String({ maxLength: 128 })),
      url: Type.Optional(Type.String({ maxLength: 2048 })),
      status: Type.Optional(Type.Number()),
      resourceType: Type.Optional(Type.String({ maxLength: 128 })),
      afterId: Type.Optional(Type.String({ maxLength: 256 })),
      afterSequence: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
    }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const d = getDiagnostics();
      const t = { sessionId: args.sessionId, tabId: args.tabId };
      authorize?.(t, ctx);
      if (args.action === "clear") {
        d.clear(t);
        return result({ cleared: true });
      }
      const history = d.read(t, args);
      let omittedLogs = 0,
        omittedRequests = 0;
      const output: Omit<typeof history, "nextSequence"> & {
        nextSequence: number | null;
        omittedLogs: number;
        omittedRequests: number;
      } = { ...history, omittedLogs, omittedRequests };
      while (
        Buffer.byteLength(JSON.stringify(output)) > 16000 &&
        (output.logs.length || output.requests.length)
      ) {
        // Account for the null cursor while checking the final byte limit.
        output.nextSequence = null;
        if (
          output.logs.length &&
          (!output.requests.length ||
            output.logs[0].time <= output.requests[0].time)
        ) {
          output.logs.shift();
          output.omittedLogs++;
        } else {
          output.requests.shift();
          output.omittedRequests++;
        }
      }
      return result(output);
    },
  });
  pi.registerTool({
    name: "browser_diagnostic_body",
    label: "Browser diagnostic body",
    description:
      "Configure capture for future requests, inspect retained bytes as base64, or explicitly save a binary artifact. Response capture is best effort for completed, declared small identity responses. Content-Length is untrusted: browser, transport and Node transient memory are not strictly bounded. Requests are never replayed. Bodies may contain secrets.",
    parameters: Type.Object({
      ...target,
      action: Type.Union([
        Type.Literal("configure"),
        Type.Literal("inspect"),
        Type.Literal("artifact"),
      ]),
      enabled: Type.Optional(Type.Boolean()),
      requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      direction: Type.Optional(
        Type.Union([Type.Literal("request"), Type.Literal("response")]),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
    }),
    async execute(_id, args, signal, _onUpdate, ctx) {
      const d = getDiagnostics(),
        t = { sessionId: args.sessionId, tabId: args.tabId };
      authorize?.(t, ctx);
      if (args.action === "configure") {
        if (args.enabled === undefined)
          throw new Error("Configure requires enabled.");
        return result(d.configureBodies(t, args.enabled));
      }
      if (!args.requestId || !args.direction)
        throw new Error("Body inspection requires requestId and direction.");
      if (args.action === "artifact") {
        if (!artifactScope)
          throw new Error("Binary artifact transport unavailable.");
        const scope = artifactScope(ctx, signal);
        return result({
          artifact: await d.exportBody(
            t,
            args.requestId,
            args.direction,
            scope.owner,
            scope.signal,
          ),
          encoding: "binary",
        });
      }
      return result(
        d.inspectBody(
          t,
          args.requestId,
          args.direction,
          args.offset,
          args.maxBytes,
        ),
      );
    },
  });
  pi.registerTool({
    name: "browser_diagnostic_headers",
    label: "Browser diagnostic headers",
    description:
      "Explicitly reveal selected retained sensitive headers for one request and direction. Cookie values may be returned.",
    parameters: Type.Object({
      ...target,
      requestId: Type.String({ minLength: 1, maxLength: 256 }),
      direction: Type.Union([
        Type.Literal("request"),
        Type.Literal("response"),
      ]),
      names: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        minItems: 1,
        maxItems: 32,
      }),
    }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      authorize?.({ sessionId: args.sessionId, tabId: args.tabId }, ctx);
      const output = getDiagnostics().inspectHeaders(
        { sessionId: args.sessionId, tabId: args.tabId },
        args.requestId,
        args.direction,
        args.names,
      );
      for (const name of Object.keys(output.values)) {
        if (Buffer.byteLength(JSON.stringify(output)) <= 16000) break;
        delete output.values[name];
        output.unavailable.push(name);
      }
      return result(output);
    },
  });
}
