import { appendFileSync } from "node:fs";
import {
  createProtocolConnection,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  ShutdownRequest,
  WorkspaceDiagnosticRequest,
} from "vscode-languageserver-protocol/node";

const logPath = process.env.FAKE_LSP_LOG;
const log = (event) => {
  if (logPath) appendFileSync(logPath, `${event}\n`);
};
const connection = createProtocolConnection(process.stdin, process.stdout);

connection.onRequest(InitializeRequest.type, () => {
  log("initialize");
  return {
    capabilities: {
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: process.env.FAKE_LSP_WORKSPACE === "1",
      },
    },
  };
});
connection.onNotification(InitializedNotification.type, () =>
  log("initialized"),
);
connection.onNotification(DidOpenTextDocumentNotification.type, (params) => {
  log(`open:${params.textDocument.version}:${params.textDocument.text}`);
  void connection.sendNotification(PublishDiagnosticsNotification.type, {
    uri: params.textDocument.uri,
    diagnostics: [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        severity: 1,
        message: "first diagnostic",
      },
    ],
  });
});
connection.onNotification(DidChangeTextDocumentNotification.type, (params) => {
  log(
    `change:${params.textDocument.version}:${params.contentChanges[0]?.text}`,
  );
  void connection.sendNotification(PublishDiagnosticsNotification.type, {
    uri: params.textDocument.uri,
    diagnostics: [],
  });
});
connection.onRequest(DocumentDiagnosticRequest.type, (params, token) => {
  log(`document:${params.textDocument.uri}`);
  if (process.env.FAKE_LSP_DELAY === "1") {
    return new Promise((resolve) => {
      token.onCancellationRequested(() => {
        log("cancel");
        resolve({ kind: "full", resultId: "cancelled", items: [] });
      });
    });
  }
  return { kind: "full", resultId: "fake-result", items: [] };
});
connection.onRequest(WorkspaceDiagnosticRequest.type, () => {
  log("workspace");
  return { items: [] };
});
connection.onRequest(ShutdownRequest.type, () => {
  log("shutdown");
  return null;
});
connection.onNotification("exit", () => {
  log("exit");
  process.exit(0);
});
connection.listen();
