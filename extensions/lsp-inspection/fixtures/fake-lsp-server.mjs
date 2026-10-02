import { appendFileSync } from "node:fs";
import {
  createProtocolConnection,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  ShutdownRequest,
  DiagnosticRefreshRequest,
  WorkspaceDiagnosticRequest,
  ResponseError,
} from "vscode-languageserver-protocol/node";

const logPath = process.env.FAKE_LSP_LOG;
const log = (event) => {
  if (logPath) appendFileSync(logPath, `${event}\n`);
};
const connection = createProtocolConnection(process.stdin, process.stdout);

const pushOnly = process.env.FAKE_LSP_PUSH_ONLY === "1";
const batchRace = process.env.FAKE_LSP_BATCH_RACE === "1";
const emptyPullKind = process.env.FAKE_LSP_EMPTY_PULL_KIND === "1";
const dynamicDiagnostics = process.env.FAKE_LSP_DYNAMIC === "1";
const dynamicWorkspaceDiagnostics =
  process.env.FAKE_LSP_DYNAMIC_WORKSPACE === "1";
const suppressDynamicRegistration =
  process.env.FAKE_LSP_SUPPRESS_DYNAMIC_REGISTRATION === "1";
const pushVersioned = process.env.FAKE_LSP_PUSH_VERSIONED === "1";
const pushDelay = Number(process.env.FAKE_LSP_PUSH_DELAY ?? 0);
const stalePushDelay = Number(process.env.FAKE_LSP_STALE_PUSH_DELAY);
let documentErrorsRemaining =
  process.env.FAKE_LSP_DOCUMENT_ERROR_ONCE === "1" ? 1 : 0;
const firstDiagnostic = {
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  },
  severity: 1,
  message: "first diagnostic",
};
const batchDiagnostics = [
  { ...firstDiagnostic, message: "rangeint diagnostic 1" },
  { ...firstDiagnostic, message: "rangeint diagnostic 2" },
];
const openDocuments = new Map();

function publish(uri, version, diagnostics, delay = pushDelay) {
  if (process.env.FAKE_LSP_PUSH_NONE === "1") return;
  setTimeout(() => {
    const params = { uri, diagnostics };
    if (pushVersioned) params.version = version;
    void connection.sendNotification(
      PublishDiagnosticsNotification.type,
      params,
    );
    log(`publish:${version}:${diagnostics.length}`);
  }, delay);
}

connection.onRequest(InitializeRequest.type, (params) => {
  log("initialize");
  log(
    `initialize-pull:${params.initializationOptions?.pullDiagnostics === true ? "true" : "none"}`,
  );
  log(
    `initialize-push:${params.capabilities?.textDocument?.publishDiagnostics ? "true" : "none"}`,
  );
  return {
    capabilities:
      pushOnly || dynamicDiagnostics
        ? {}
        : {
            diagnosticProvider: {
              interFileDependencies: false,
              workspaceDiagnostics: process.env.FAKE_LSP_WORKSPACE === "1",
            },
          },
  };
});
connection.onNotification(InitializedNotification.type, () => {
  log("initialized");
  if (dynamicDiagnostics && !suppressDynamicRegistration) {
    void connection
      .sendRequest(RegistrationRequest.type, {
        registrations: [
          {
            id: "dynamic-diagnostics",
            method: "textDocument/diagnostic",
            registerOptions: {
              interFileDependencies: false,
              workspaceDiagnostics: dynamicWorkspaceDiagnostics,
            },
          },
        ],
      })
      .then(() => log("dynamic-registered"));
  }
});
connection.onNotification(DidOpenTextDocumentNotification.type, (params) => {
  openDocuments.set(params.textDocument.uri, params.textDocument.text);
  log(`open:${params.textDocument.version}:${params.textDocument.text}`);
  publish(
    params.textDocument.uri,
    params.textDocument.version,
    params.textDocument.text.includes("clean") ? [] : [firstDiagnostic],
  );
});
connection.onNotification(DidCloseTextDocumentNotification.type, (params) => {
  openDocuments.delete(params.textDocument.uri);
  log(`close:${params.textDocument.uri}`);
});
connection.onNotification(DidChangeTextDocumentNotification.type, (params) => {
  openDocuments.set(
    params.textDocument.uri,
    params.contentChanges[0]?.text ?? "",
  );
  log(
    `change:${params.textDocument.version}:${params.contentChanges[0]?.text}`,
  );
  if (Number.isFinite(stalePushDelay)) {
    publish(
      params.textDocument.uri,
      params.textDocument.version - 1,
      [firstDiagnostic],
      stalePushDelay,
    );
  }
  publish(params.textDocument.uri, params.textDocument.version, []);
});
connection.onRequest(DocumentDiagnosticRequest.type, (params, token) => {
  log(`document:${params.textDocument.uri}`);
  log(`document-previous:${params.previousResultId ?? "none"}`);
  if (documentErrorsRemaining > 0) {
    documentErrorsRemaining -= 1;
    log("document-error");
    throw new ResponseError(-32001, "no package metadata for fake file");
  }
  if (batchRace) {
    const target = params.textDocument.uri.endsWith("/splaytree_test.go");
    const items = target && openDocuments.size === 1 ? batchDiagnostics : [];
    if (target) {
      log(`document-target:${items.length}`);
      log(`document-open:${openDocuments.size}`);
    }
    return new Promise((resolve) => {
      setTimeout(
        () =>
          resolve({
            kind: emptyPullKind ? "" : "full",
            resultId: "fake-result",
            items,
          }),
        5,
      );
    });
  }
  if (process.env.FAKE_LSP_DELAY === "1") {
    return new Promise((resolve) => {
      token.onCancellationRequested(() => {
        log("cancel");
        resolve({ kind: "full", resultId: "cancelled", items: [] });
      });
    });
  }
  const report = { kind: "full", resultId: "fake-result", items: [] };
  if (process.env.FAKE_LSP_REFRESH === "1") {
    return connection.sendRequest(DiagnosticRefreshRequest.type).then(() => {
      log("refresh-ack");
      return report;
    });
  }
  return report;
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
