import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_FILE_NAME = "pi-tools.json";
export const DEFAULT_CONFIG_DIR_NAME = ".pi";
export const CONFIG_VERSION = 1;
export const SETTINGS_DEFINITION_REQUEST_EVENT =
  "pi-tools:settings-definition-request";
export const SETTINGS_DEFINITION_EVENT = "pi-tools:settings-definition";

export type ConfigScope = "default" | "global" | "project";
export type WritableConfigScope = Exclude<ConfigScope, "default">;
export type SettingValue = boolean | number | string;

type SettingMetadata = {
  /** Short display name used in the `/pi-tools` settings list. */
  label?: string;
  description?: string;
};

export type BooleanSettingDefinition = SettingMetadata & {
  type: "boolean";
  default: boolean;
};

export type NumberSettingDefinition = SettingMetadata & {
  type: "number";
  default: number;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
};

export type StringSettingDefinition = SettingMetadata & {
  type: "string";
  default: string;
};

export type EnumSettingDefinition = SettingMetadata & {
  type: "enum";
  default: string;
  values: readonly string[];
};

export type SettingDefinition =
  | BooleanSettingDefinition
  | NumberSettingDefinition
  | StringSettingDefinition
  | EnumSettingDefinition;

export type ExtensionSettingsDefinition = {
  id: string;
  label: string;
  description?: string;
  fields: Record<string, SettingDefinition>;
  toolNames?: readonly string[];
};

export type ExtensionSettingsEventBus = {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
};

export type ConfigDiagnostic = {
  scope: Exclude<ConfigScope, "default">;
  path: string;
  message: string;
};

export type ConfigPaths = {
  global: string;
  project: string;
};

type ConfigExtensionValues = Record<string, unknown>;
type ConfigDocument = {
  version: number;
  extensions: Record<string, ConfigExtensionValues>;
};

export type EffectiveSettings = {
  values: Record<string, Record<string, unknown>>;
  sources: Record<string, Record<string, ConfigScope>>;
  diagnostics: ConfigDiagnostic[];
  paths: ConfigPaths;
  projectTrusted: boolean;
};

export type EffectiveSettingsOptions = {
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
  configDirName?: string;
  registry?: SettingsRegistry;
};

export type UpdateSettingOptions = {
  scope: WritableConfigScope;
  cwd: string;
  projectTrusted: boolean;
  extensionId: string;
  field: string;
  value: unknown;
  agentDir?: string;
  configDirName?: string;
  registry?: SettingsRegistry;
};

export class SettingsRegistry {
  private definitions = new Map<string, ExtensionSettingsDefinition>();

  register(definition: ExtensionSettingsDefinition): void {
    validateDefinition(definition);
    const frozen = freezeDefinition(definition);
    const existing = this.definitions.get(definition.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(frozen)) {
        throw new Error(
          `Conflicting settings are registered for extension '${definition.id}'.`,
        );
      }
      return;
    }
    this.definitions.set(definition.id, frozen);
  }

  get(id: string): ExtensionSettingsDefinition | undefined {
    return this.definitions.get(id);
  }

  replace(definition: ExtensionSettingsDefinition): void {
    validateDefinition(definition);
    this.definitions.set(definition.id, freezeDefinition(definition));
  }

  list(): ExtensionSettingsDefinition[] {
    return Array.from(this.definitions.values());
  }

  clear(): void {
    this.definitions.clear();
  }
}

export const settingsRegistry = new SettingsRegistry();

export function registerExtensionSettings(
  definition: ExtensionSettingsDefinition,
): void {
  settingsRegistry.register(definition);
}

export function publishExtensionSettings(
  events: ExtensionSettingsEventBus,
  definition: ExtensionSettingsDefinition,
): void {
  registerExtensionSettings(definition);
  events.on(SETTINGS_DEFINITION_REQUEST_EVENT, () => {
    events.emit(SETTINGS_DEFINITION_EVENT, definition);
  });
}

export function getConfigPaths(options: {
  cwd: string;
  agentDir?: string;
  configDirName?: string;
}): ConfigPaths {
  const agentDir =
    options.agentDir ??
    process.env.PI_CODING_AGENT_DIR ??
    join(homedir(), ".pi", "agent");
  const configDirName = options.configDirName ?? DEFAULT_CONFIG_DIR_NAME;

  return {
    global: join(agentDir, CONFIG_FILE_NAME),
    project: join(options.cwd, configDirName, CONFIG_FILE_NAME),
  };
}

export async function getEffectiveSettings(
  options: EffectiveSettingsOptions,
): Promise<EffectiveSettings> {
  const registry = options.registry ?? settingsRegistry;
  const paths = getConfigPaths(options);
  const diagnostics: ConfigDiagnostic[] = [];
  const global = await readConfigDocument(paths.global, "global", diagnostics);
  const project = options.projectTrusted
    ? await readConfigDocument(paths.project, "project", diagnostics)
    : emptyConfigDocument();

  const values: Record<string, Record<string, unknown>> = {};
  const sources: Record<string, Record<string, ConfigScope>> = {};

  for (const definition of registry.list()) {
    const extensionValues: Record<string, unknown> = {};
    const extensionSources: Record<string, ConfigScope> = {};
    const globalOverrides = global.extensions[definition.id] ?? {};
    const projectOverrides = project.extensions[definition.id] ?? {};

    for (const [field, fieldDefinition] of Object.entries(definition.fields)) {
      let value: SettingValue = fieldDefinition.default;
      let source: ConfigScope = "default";
      const globalValue = getPath(globalOverrides, field);
      if (globalValue !== undefined) {
        if (isValidSettingValue(fieldDefinition, globalValue)) {
          value = globalValue;
          source = "global";
        } else {
          diagnostics.push(
            invalidValueDiagnostic(
              "global",
              paths.global,
              definition.id,
              field,
            ),
          );
        }
      }

      const projectValue = getPath(projectOverrides, field);
      if (projectValue !== undefined) {
        if (isValidSettingValue(fieldDefinition, projectValue)) {
          value = projectValue;
          source = "project";
        } else {
          diagnostics.push(
            invalidValueDiagnostic(
              "project",
              paths.project,
              definition.id,
              field,
            ),
          );
        }
      }

      setPath(extensionValues, field, value);
      extensionSources[field] = source;
    }

    values[definition.id] = extensionValues;
    sources[definition.id] = extensionSources;
  }

  return {
    values,
    sources,
    diagnostics,
    paths,
    projectTrusted: options.projectTrusted,
  };
}

export async function updateSetting(
  options: UpdateSettingOptions,
): Promise<void> {
  if (options.scope === "project" && !options.projectTrusted) {
    throw new Error(
      "Cannot write project pi-tools settings until the project is trusted.",
    );
  }

  const registry = options.registry ?? settingsRegistry;
  const extension = registry.get(options.extensionId);
  if (!extension) {
    throw new Error(`Unknown pi-tools extension '${options.extensionId}'.`);
  }

  const definition = extension.fields[options.field];
  if (!definition) {
    throw new Error(
      `Unknown setting '${options.field}' for extension '${options.extensionId}'.`,
    );
  }

  if (!isValidSettingValue(definition, options.value)) {
    throw new Error(
      `Invalid value for '${options.extensionId}.${options.field}'.`,
    );
  }

  const paths = getConfigPaths(options);
  const path = paths[options.scope];
  await queueWrite(path, async () => {
    const diagnostics: ConfigDiagnostic[] = [];
    const document = await readConfigDocument(path, options.scope, diagnostics);
    const extensionValues = document.extensions[options.extensionId] ?? {};
    setPath(extensionValues, options.field, options.value);
    document.extensions[options.extensionId] = extensionValues;
    await writeConfigDocument(path, document);
  });
}

export function getSettingValue<T extends SettingValue>(
  settings: EffectiveSettings,
  extensionId: string,
  field: string,
): T | undefined {
  const extension = settings.values[extensionId];
  if (!extension) return undefined;
  return getPath(extension, field) as T | undefined;
}

export function parseSettingInput(
  definition: SettingDefinition,
  input: string,
): SettingValue | undefined {
  if (definition.type === "boolean") {
    const normalized = input.trim().toLowerCase();
    if (["true", "on", "enabled"].includes(normalized)) return true;
    if (["false", "off", "disabled"].includes(normalized)) return false;
    return undefined;
  }

  if (definition.type === "number") {
    const value = Number(input.trim());
    return input.trim() !== "" && isValidSettingValue(definition, value)
      ? value
      : undefined;
  }

  return isValidSettingValue(definition, input) ? input : undefined;
}

function validateDefinition(definition: ExtensionSettingsDefinition): void {
  if (!isSafePathSegment(definition.id)) {
    throw new Error(
      "Extension setting ids must be non-empty, dot-free strings.",
    );
  }
  if (!definition.label.trim()) {
    throw new Error(`Extension '${definition.id}' must have a label.`);
  }

  for (const [field, setting] of Object.entries(definition.fields)) {
    if (!isValidFieldPath(field)) {
      throw new Error(
        `Invalid settings field '${field}' for '${definition.id}'.`,
      );
    }
    if (setting.label !== undefined && !setting.label.trim()) {
      throw new Error(`Invalid display label for '${definition.id}.${field}'.`);
    }
    if (!isValidSettingValue(setting, setting.default)) {
      throw new Error(`Invalid default for '${definition.id}.${field}'.`);
    }
    if (setting.type === "number") {
      if (
        (setting.minimum !== undefined && !Number.isFinite(setting.minimum)) ||
        (setting.maximum !== undefined && !Number.isFinite(setting.maximum)) ||
        (setting.minimum !== undefined &&
          setting.maximum !== undefined &&
          setting.minimum > setting.maximum)
      ) {
        throw new Error(`Invalid range for '${definition.id}.${field}'.`);
      }
    }
    if (setting.type === "enum" && setting.values.length === 0) {
      throw new Error(
        `Enum '${definition.id}.${field}' must declare at least one value.`,
      );
    }
  }
}

function freezeDefinition(
  definition: ExtensionSettingsDefinition,
): ExtensionSettingsDefinition {
  return Object.freeze({
    ...definition,
    fields: Object.freeze(
      Object.fromEntries(
        Object.entries(definition.fields).map(([field, setting]) => [
          field,
          freezeSettingDefinition(setting),
        ]),
      ),
    ),
    toolNames: definition.toolNames
      ? Object.freeze([...definition.toolNames])
      : undefined,
  });
}

function freezeSettingDefinition(
  setting: SettingDefinition,
): SettingDefinition {
  if (setting.type === "enum") {
    return Object.freeze({
      ...setting,
      values: Object.freeze([...setting.values]),
    });
  }
  return Object.freeze({ ...setting });
}

function isValidSettingValue(
  definition: SettingDefinition,
  value: unknown,
): value is SettingValue {
  switch (definition.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!definition.integer || Number.isInteger(value)) &&
        (definition.minimum === undefined || value >= definition.minimum) &&
        (definition.maximum === undefined || value <= definition.maximum)
      );
    case "string":
      return typeof value === "string";
    case "enum":
      return typeof value === "string" && definition.values.includes(value);
  }
}

function emptyConfigDocument(): ConfigDocument {
  return { version: CONFIG_VERSION, extensions: {} };
}

async function readConfigDocument(
  path: string,
  scope: Exclude<ConfigScope, "default">,
  diagnostics: ConfigDiagnostic[],
): Promise<ConfigDocument> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const document = parseConfigDocument(parsed);
    if (!document) {
      diagnostics.push({
        scope,
        path,
        message: `Ignoring invalid pi-tools configuration at ${path}.`,
      });
      return emptyConfigDocument();
    }
    return document;
  } catch (error) {
    if (isMissingFileError(error)) return emptyConfigDocument();
    diagnostics.push({
      scope,
      path,
      message: `Ignoring unreadable pi-tools configuration at ${path}.`,
    });
    return emptyConfigDocument();
  }
}

function parseConfigDocument(value: unknown): ConfigDocument | undefined {
  if (
    !isRecord(value) ||
    value.version !== CONFIG_VERSION ||
    !isRecord(value.extensions)
  ) {
    return undefined;
  }

  const extensions: Record<string, ConfigExtensionValues> = {};
  for (const [id, extensionValue] of Object.entries(value.extensions)) {
    if (isSafePathSegment(id) && isRecord(extensionValue)) {
      extensions[id] = structuredClone(extensionValue);
    }
  }

  return { version: CONFIG_VERSION, extensions };
}

async function writeConfigDocument(
  path: string,
  document: ConfigDocument,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const body = `${JSON.stringify(document, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup only; the original error is more useful.
    }
    throw error;
  }
}

function invalidValueDiagnostic(
  scope: Exclude<ConfigScope, "default">,
  path: string,
  extensionId: string,
  field: string,
): ConfigDiagnostic {
  return {
    scope,
    path,
    message: `Ignoring invalid value for '${extensionId}.${field}' in ${path}.`,
  };
}

function getPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment))
      return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(
  value: Record<string, unknown>,
  path: string,
  setting: unknown,
): void {
  const segments = path.split(".");
  const last = segments.pop();
  if (!last) throw new Error(`Invalid empty settings path '${path}'.`);

  let current = value;
  for (const segment of segments) {
    const next = current[segment];
    if (!isRecord(next)) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    } else {
      current = next;
    }
  }
  current[last] = setting;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes(".") &&
    !Object.hasOwn(Object.prototype, value) &&
    value !== "prototype"
  );
}

function isValidFieldPath(value: string): boolean {
  return value.split(".").every(isSafePathSegment);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

const pendingWrites = new Map<string, Promise<void>>();

function queueWrite(path: string, write: () => Promise<void>): Promise<void> {
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(write);
  pendingWrites.set(path, next);
  return next.finally(() => {
    if (pendingWrites.get(path) === next) pendingWrites.delete(path);
  });
}
