import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MAX_RETRIEVAL_MAX_BYTES, type ToolOutputStore } from "./store.ts";

export const RETRIEVE_TOOL_OUTPUT_NAME = "retrieve_tool_output";

export function registerRetrieveTool(
  pi: ExtensionAPI,
  getStore: () => ToolOutputStore,
) {
  pi.registerTool({
    name: RETRIEVE_TOOL_OUTPUT_NAME,
    label: "Retrieve Tool Output",
    description:
      "Retrieve a bounded chunk of a previously stored tool output by its reference id. References are accessible only within the current Pi session.",
    promptSnippet:
      "Retrieve original text from a tool-output compression reference",
    promptGuidelines: [
      "Use retrieve_tool_output only when a tool-output compression reference provides an id and the original text is needed.",
      "Use retrieve_tool_output.offset with the returned nextOffset to request the next bounded chunk.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "Retrieval id from a compression reference",
      }),
      offset: Type.Optional(
        Type.Integer({
          description: "UTF-8 byte offset for the next chunk",
          minimum: 0,
        }),
      ),
      maxBytes: Type.Optional(
        Type.Integer({
          description: "Maximum UTF-8 bytes to return",
          minimum: 1_024,
          maximum: MAX_RETRIEVAL_MAX_BYTES,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const requestedBytes = params.maxBytes ?? MAX_RETRIEVAL_MAX_BYTES;
      // Reserve room for the provenance/truncation notice within Pi's 50 KiB
      // custom-tool output limit.
      const result = await getStore().retrieve(
        params.id,
        ctx.sessionManager.getSessionId(),
        {
          offset: params.offset,
          maxBytes: Math.max(1_024, requestedBytes - 512),
          signal,
        },
      );

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No available stored tool output matches ${params.id} in this session.`,
            },
          ],
          details: { found: false, id: params.id },
        };
      }

      const header = [
        `Stored tool output: ${result.toolName} · ${result.contentBytes} bytes`,
        `Reference: ${result.id} · bytes ${result.offset}-${result.nextOffset ?? result.contentBytes} of ${result.contentBytes}`,
      ];
      if (result.nextOffset !== undefined) {
        header.push(
          `More content is available. Call ${RETRIEVE_TOOL_OUTPUT_NAME} with offset ${result.nextOffset}.`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `${header.join("\n")}\n\n${result.content}`,
          },
        ],
        details: {
          found: true,
          id: result.id,
          toolName: result.toolName,
          contentBytes: result.contentBytes,
          offset: result.offset,
          nextOffset: result.nextOffset,
        },
      };
    },
  });
}
