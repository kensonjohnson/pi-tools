import type { WritableConfigScope } from "./pi-tools-config.ts";

export type SettingAddress = {
  extensionId: string;
  field: string;
};

export type PiToolsCommand =
  | { action: "open"; scope?: WritableConfigScope }
  | { action: "status" }
  | { action: "paths" }
  | { action: "get"; address: SettingAddress }
  | {
      action: "set";
      scope?: WritableConfigScope;
      address: SettingAddress;
      input: string;
    }
  | {
      action: "enable" | "disable";
      scope?: WritableConfigScope;
      extensionId: string;
    };

export type ParseCommandResult =
  | { command: PiToolsCommand }
  | { error: string };

export function parsePiToolsCommand(args: string): ParseCommandResult {
  const tokenResult = tokenize(args);
  if ("error" in tokenResult) return tokenResult;
  const tokens = tokenResult.tokens;
  let scope: WritableConfigScope | undefined;
  let optionsEnded = false;
  const remaining: string[] = [];

  for (const token of tokens) {
    if (token === "--" && !optionsEnded) {
      optionsEnded = true;
    } else if (token === "--global" && !optionsEnded) {
      if (scope && scope !== "global") return { error: "Choose either --global or --project." };
      scope = "global";
    } else if (token === "--project" && !optionsEnded) {
      if (scope && scope !== "project") return { error: "Choose either --global or --project." };
      scope = "project";
    } else {
      remaining.push(token);
    }
  }

  if (remaining.length === 0) return { command: { action: "open", scope } };

  const [action, ...values] = remaining;
  switch (action.toLowerCase()) {
    case "status":
      return values.length === 0 && !scope
        ? { command: { action: "status" } }
        : { error: "Usage: /pi-tools status" };
    case "paths":
      return values.length === 0 && !scope
        ? { command: { action: "paths" } }
        : { error: "Usage: /pi-tools paths" };
    case "get": {
      if (values.length !== 1) return { error: "Usage: /pi-tools get <extension.setting>" };
      const address = parseSettingAddress(values[0]);
      return address ? { command: { action: "get", address } } : invalidAddress();
    }
    case "set": {
      if (values.length < 2) {
        return { error: "Usage: /pi-tools [--global|--project] set <extension.setting> <value>" };
      }
      const address = parseSettingAddress(values[0]);
      if (!address) return invalidAddress();
      return {
        command: { action: "set", scope, address, input: values.slice(1).join(" ") },
      };
    }
    case "enable":
    case "disable":
      return values.length === 1 && isExtensionId(values[0])
        ? { command: { action, scope, extensionId: values[0] } }
        : { error: `Usage: /pi-tools [--global|--project] ${action} <extension>` };
    default:
      return { error: `Unknown pi-tools command '${action}'.` };
  }
}

function parseSettingAddress(value: string): SettingAddress | undefined {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const extensionId = value.slice(0, separator);
  const field = value.slice(separator + 1);
  return isExtensionId(extensionId) && isField(field)
    ? { extensionId, field }
    : undefined;
}

function isExtensionId(value: string): boolean {
  return isSegment(value);
}

function isField(value: string): boolean {
  return value.split(".").every(isSegment);
}

function isSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !Object.hasOwn(Object.prototype, value) &&
    value !== "prototype"
  );
}

function invalidAddress(): ParseCommandResult {
  return { error: "Settings must use the form <extension.setting>." };
}

function tokenize(input: string): { tokens: string[] } | { error: string } {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const character of input.trim()) {
    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      tokenStarted = true;
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      tokenStarted = true;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaping) return { error: "Command ends with an unfinished escape." };
  if (quote) return { error: "Command contains an unclosed quote." };
  if (tokenStarted) tokens.push(token);
  return { tokens };
}
