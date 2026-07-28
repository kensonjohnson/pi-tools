import {
  CONFIG_DIR_NAME,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  decodeKittyPrintable,
  Input,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import {
  getEffectiveSettings,
  getSettingValue,
  parseSettingInput,
  SETTINGS_DEFINITION_EVENT,
  SETTINGS_DEFINITION_REQUEST_EVENT,
  SettingsRegistry,
  type ConfigScope,
  type EffectiveSettings,
  type ExtensionSettingsDefinition,
  type SettingDefinition,
  type SettingValue,
  type WritableConfigScope,
  updateSetting,
} from "../lib/pi-tools-config.ts";
import {
  parsePiToolsCommand,
  type PiToolsCommand,
} from "../lib/pi-tools-command.ts";

const SCOPE_ITEM_ID = "__pi_tools_scope__";
const managerSettingsRegistry = new SettingsRegistry();
let requestSettingsDefinitions = () => {};

type RegisteredField = {
  definition: ExtensionSettingsDefinition;
  field: string;
  setting: SettingDefinition;
};

function getSettings(ctx: ExtensionCommandContext): Promise<EffectiveSettings> {
  requestSettingsDefinitions();
  return getEffectiveSettings({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    configDirName: CONFIG_DIR_NAME,
    registry: managerSettingsRegistry,
  });
}

function getRegisteredField(
  extensionId: string,
  field: string,
): RegisteredField | undefined {
  const definition = managerSettingsRegistry.get(extensionId);
  const setting = definition?.fields[field];
  return definition && setting ? { definition, field, setting } : undefined;
}

function formatValue(value: SettingValue | undefined): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return value === undefined ? "(unset)" : String(value);
}

function formatSource(source: ConfigScope): string {
  return source === "default" ? "default" : `${source} override`;
}

function formatSettingsStatus(settings: EffectiveSettings): string {
  const lines = [
    "Pi-tools configuration",
    `Global: ${settings.paths.global}`,
    `Project: ${settings.paths.project} (${settings.projectTrusted ? "trusted" : "ignored until trusted"})`,
  ];

  for (const definition of managerSettingsRegistry.list()) {
    lines.push(`\n${definition.label}:`);
    for (const field of Object.keys(definition.fields)) {
      const value = getSettingValue(settings, definition.id, field);
      const source = settings.sources[definition.id]?.[field] ?? "default";
      lines.push(`  ${field} = ${formatValue(value)} (${formatSource(source)})`);
    }
  }

  if (managerSettingsRegistry.list().length === 0) {
    lines.push("\nNo pi-tools extensions have registered settings yet.");
  }
  if (settings.diagnostics.length > 0) {
    lines.push(`\nIgnored ${settings.diagnostics.length} invalid configuration value(s).`);
  }
  return lines.join("\n");
}

function createTextSubmenu(
  label: string,
  currentValue: string,
  theme: Theme,
  done: (selectedValue?: string) => void,
  prefillCurrentValue = true,
) {
  const input = new Input();
  if (prefillCurrentValue) input.setValue(currentValue);
  input.focused = true;
  input.onSubmit = (value) => done(value);
  input.onEscape = () => done();

  return {
    render(width: number): string[] {
      return [
        theme.fg(
          "accent",
          theme.bold(
            prefillCurrentValue ? `Edit ${label}` : `Edit ${label} (current: ${currentValue})`,
          ),
        ),
        "Enter to save · Esc to cancel",
        "",
        ...input.render(width),
      ];
    },
    invalidate(): void {
      input.invalidate();
    },
    handleInput(data: string): void {
      input.handleInput(data);
    },
  };
}

function createSettingItem(
  field: RegisteredField,
  settings: EffectiveSettings,
  theme: Theme,
  label = field.setting.label ?? field.field,
): SettingItem {
  const value = getSettingValue(settings, field.definition.id, field.field);
  const source = settings.sources[field.definition.id]?.[field.field] ?? "default";
  const description = [
    field.setting.description ?? field.definition.description,
    `Effective value: ${formatSource(source)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const item: SettingItem = {
    id: `${field.definition.id}.${field.field}`,
    label,
    description,
    currentValue: formatValue(value),
  };

  if (field.setting.type === "boolean") {
    item.values = ["on", "off"];
  } else if (field.setting.type === "enum") {
    item.values = [...field.setting.values];
  } else {
    item.submenu = (currentValue, done) =>
      createTextSubmenu(
        label,
        currentValue,
        theme,
        done,
        field.setting.type === "string",
      );
  }

  return item;
}

function createSettingsItems(
  registeredFields: RegisteredField[],
  settings: EffectiveSettings,
  theme: Theme,
  scope: WritableConfigScope,
  projectTrusted: boolean,
): SettingItem[] {
  const items: SettingItem[] = [
    {
      id: SCOPE_ITEM_ID,
      label: "Write scope",
      description: projectTrusted
        ? "Choose where the next edited setting is written."
        : "Project overrides require project trust.",
      currentValue: scope,
      values: projectTrusted ? ["global", "project"] : ["global"],
    },
  ];

  for (const definition of managerSettingsRegistry.list()) {
    const fields = registeredFields.filter(
      (field) => field.definition.id === definition.id,
    );
    const enabled = fields.find((field) => field.field === "enabled");
    if (enabled) {
      items.push(createSettingItem(enabled, settings, theme, definition.label));
    }

    const children = enabled
      ? fields.filter((field) => field !== enabled)
      : fields;
    children.forEach((field, index) => {
      const branch = index === children.length - 1 ? "└─" : "├─";
      const fieldLabel = field.setting.label ?? field.field;
      const label = enabled
        ? `${branch} ${fieldLabel}`
        : `${definition.label} › ${fieldLabel}`;
      items.push(createSettingItem(field, settings, theme, label));
    });
  }

  return items;
}

function getDefaultScope(
  requestedScope: WritableConfigScope | undefined,
  ctx: ExtensionCommandContext,
): WritableConfigScope {
  if (requestedScope === "project" && !ctx.isProjectTrusted()) {
    throw new Error("Cannot edit project pi-tools settings until the project is trusted.");
  }
  return requestedScope ?? "global";
}

async function saveSetting(
  ctx: ExtensionCommandContext,
  scope: WritableConfigScope,
  field: RegisteredField,
  value: SettingValue,
): Promise<void> {
  await updateSetting({
    scope,
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    configDirName: CONFIG_DIR_NAME,
    registry: managerSettingsRegistry,
    extensionId: field.definition.id,
    field: field.field,
    value,
  });
}

async function openSettingsUI(
  ctx: ExtensionCommandContext,
  requestedScope?: WritableConfigScope,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Open /pi-tools in TUI mode, or use /pi-tools get/set commands.", "warning");
    return;
  }

  let scope: WritableConfigScope;
  try {
    scope = getDefaultScope(requestedScope, ctx);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    return;
  }

  const settings = await getSettings(ctx);
  let savePromise: Promise<void> | undefined;
  let settingsChanged = false;

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const registeredFields = managerSettingsRegistry.list().flatMap((definition) =>
      Object.entries(definition.fields).map(([field, setting]) => ({
        definition,
        field,
        setting,
      })),
    );
    const items = createSettingsItems(
      registeredFields,
      settings,
      theme,
      scope,
      ctx.isProjectTrusted(),
    );

    let editingTextValue = false;
    for (const item of items) {
      if (!item.submenu) continue;
      const openSubmenu = item.submenu;
      item.submenu = (currentValue, closeSubmenu) => {
        editingTextValue = true;
        return openSubmenu(currentValue, (selectedValue) => {
          editingTextValue = false;
          closeSubmenu(selectedValue);
        });
      };
    }

    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Pi-tools Settings")), 1, 1),
    );
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          `Global: ${settings.paths.global}\nProject: ${settings.paths.project}`,
        ),
        1,
        0,
      ),
    );
    if (registeredFields.length === 0) {
      container.addChild(
        new Text(
          theme.fg("dim", "No extensions have registered settings yet."),
          1,
          1,
        ),
      );
    }

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      {
        ...getSettingsListTheme(),
        hint: () =>
          theme.fg(
            "dim",
            "  j/k or ↑/↓ to move · Enter/Space to change · Esc to apply changes",
          ),
      },
      (id, input) => {
        if (id === SCOPE_ITEM_ID) {
          scope = input as WritableConfigScope;
          settingsList.updateValue(SCOPE_ITEM_ID, scope);
          tui.requestRender();
          return;
        }
        if (savePromise) return;

        const separator = id.indexOf(".");
        const registered =
          separator > 0 ? getRegisteredField(id.slice(0, separator), id.slice(separator + 1)) : undefined;
        if (!registered) {
          ctx.ui.notify(`Unknown pi-tools setting '${id}'.`, "error");
          return;
        }

        const value = parseSettingInput(registered.setting, input);
        if (value === undefined) {
          ctx.ui.notify(`Invalid value for ${registered.definition.id}.${registered.field}.`, "warning");
          return;
        }

        const pendingSave = saveSetting(ctx, scope, registered, value)
          .then(() => {
            settingsChanged = true;
          })
          .catch((error) => {
            ctx.ui.notify(
              error instanceof Error ? `Could not save setting: ${error.message}` : "Could not save setting.",
              "error",
            );
          });
        savePromise = pendingSave;
        void pendingSave.finally(() => {
          if (savePromise === pendingSave) savePromise = undefined;
        });
      },
      () => done(undefined),
      { enableSearch: false },
    );
    container.addChild(settingsList);

    return {
      render(width: number): string[] {
        return container.render(width);
      },
      invalidate(): void {
        container.invalidate();
      },
      handleInput(data: string): void {
        const printable = decodeKittyPrintable(data) ?? data;
        const navigationData = editingTextValue
          ? data
          : printable === "j"
            ? "\u001b[B"
            : printable === "k"
              ? "\u001b[A"
              : data;
        settingsList.handleInput(navigationData);
        tui.requestRender();
      },
    };
  });

  if (savePromise) await savePromise;
  if (settingsChanged) {
    ctx.ui.notify("Applying pi-tools settings", "info");
    await ctx.reload();
  }
}

async function handleCommand(
  command: PiToolsCommand,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (command.action === "open") {
    await openSettingsUI(ctx, command.scope);
    return;
  }

  const settings = await getSettings(ctx);
  if (command.action === "status") {
    ctx.ui.notify(formatSettingsStatus(settings), "info");
    return;
  }
  if (command.action === "paths") {
    ctx.ui.notify(
      `Global: ${settings.paths.global}\nProject: ${settings.paths.project}${settings.projectTrusted ? "" : " (ignored until trusted)"}`,
      "info",
    );
    return;
  }

  if (command.action === "get") {
    const field = getRegisteredField(
      command.address.extensionId,
      command.address.field,
    );
    if (!field) {
      ctx.ui.notify("Unknown pi-tools setting.", "warning");
      return;
    }
    const value = getSettingValue(settings, field.definition.id, field.field);
    const source = settings.sources[field.definition.id]?.[field.field] ?? "default";
    ctx.ui.notify(`${formatValue(value)} (${formatSource(source)})`, "info");
    return;
  }

  const scope = getDefaultScope(command.scope, ctx);
  const field =
    command.action === "set"
      ? getRegisteredField(command.address.extensionId, command.address.field)
      : getRegisteredField(command.extensionId, "enabled");
  if (!field) {
    ctx.ui.notify("Unknown pi-tools setting.", "warning");
    return;
  }

  const input = command.action === "set" ? command.input : command.action === "enable" ? "on" : "off";
  const value = parseSettingInput(field.setting, input);
  if (value === undefined) {
    ctx.ui.notify(`Invalid value for ${field.definition.id}.${field.field}.`, "warning");
    return;
  }
  await saveAndReload(ctx, scope, field, value);
}

export default function (pi: ExtensionAPI) {
  pi.events.on(SETTINGS_DEFINITION_EVENT, (definition) => {
    try {
      managerSettingsRegistry.replace(definition as ExtensionSettingsDefinition);
    } catch {
      // Ignore malformed or conflicting definitions from another extension.
    }
  });
  requestSettingsDefinitions = () => {
    managerSettingsRegistry.clear();
    pi.events.emit(SETTINGS_DEFINITION_REQUEST_EVENT, undefined);
  };

  pi.registerCommand("pi-tools", {
    description: "View and edit pi-tools extension settings",
    handler: async (args, ctx) => {
      const parsed = parsePiToolsCommand(args);
      if ("error" in parsed) {
        ctx.ui.notify(
          `${parsed.error}\nUsage: /pi-tools [--global|--project] [status|paths|get|set|enable|disable]`,
          "warning",
        );
        return;
      }

      try {
        await handleCommand(parsed.command, ctx);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Could not update pi-tools settings.",
          "error",
        );
      }
    },
  });
}
