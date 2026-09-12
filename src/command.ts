import { relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
  type ConfigScope,
  DEFAULT_CODEX_BACKGROUND,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_QUALITY,
  DEFAULT_CODEX_SIZE,
  DEFAULT_PROVIDER,
  DEFAULT_XAI_MODEL,
  deleteConfig,
  formatStatus,
  getConfigPath,
  isProjectTrustedContext,
  loadConfig,
  type PiImagenConfig,
  type ResolvedImagenConfig,
  saveConfig,
} from "./config.ts";

const COMMAND_NAME = "imagen-settings";
const SUBCOMMANDS = ["status", "reset"] as const;

const DEFAULT_SUFFIX = " (default)";
const defaultTag = (value: string): string => `${value}${DEFAULT_SUFFIX}`;
const isDefaultTag = (value: string): boolean => value.endsWith(DEFAULT_SUFFIX);

interface CycleField {
  id: string;
  label: string;
  description: string;
  values(cfg: PiImagenConfig): string[];
  get(cfg: PiImagenConfig): string;
  apply(cfg: PiImagenConfig, value: string): void;
}

interface TextField {
  id: string;
  label: string;
  description: string;
  defaultDisplay: string;
  get(cfg: PiImagenConfig): string | undefined;
  apply(cfg: PiImagenConfig, value: string): void;
}

const CYCLE_FIELDS: CycleField[] = [
  {
    id: "defaultProvider",
    label: "Default provider",
    description: "Used when tool omits provider and model does not imply codex",
    values: () => [defaultTag(DEFAULT_PROVIDER), "codex", "xai"],
    get: (c) =>
      c.defaultProvider === undefined || c.defaultProvider === DEFAULT_PROVIDER
        ? defaultTag(DEFAULT_PROVIDER)
        : c.defaultProvider,
    apply: (c, v) => {
      if (isDefaultTag(v)) delete c.defaultProvider;
      else c.defaultProvider = v as "xai" | "codex";
    },
  },
  {
    id: "codexQuality",
    label: "Codex quality",
    description: "Default quality for provider=codex",
    values: () => [defaultTag(DEFAULT_CODEX_QUALITY), "low", "medium", "high", "auto"],
    get: (c) =>
      c.codexQuality === undefined || c.codexQuality === DEFAULT_CODEX_QUALITY
        ? defaultTag(DEFAULT_CODEX_QUALITY)
        : c.codexQuality,
    apply: (c, v) => {
      if (isDefaultTag(v)) delete c.codexQuality;
      else c.codexQuality = v as NonNullable<PiImagenConfig["codexQuality"]>;
    },
  },
  {
    id: "codexBackground",
    label: "Codex background",
    description: "Default background for provider=codex",
    values: () => [defaultTag(DEFAULT_CODEX_BACKGROUND), "opaque", "transparent", "auto"],
    get: (c) =>
      c.codexBackground === undefined || c.codexBackground === DEFAULT_CODEX_BACKGROUND
        ? defaultTag(DEFAULT_CODEX_BACKGROUND)
        : c.codexBackground,
    apply: (c, v) => {
      if (isDefaultTag(v)) delete c.codexBackground;
      else c.codexBackground = v as NonNullable<PiImagenConfig["codexBackground"]>;
    },
  },
  {
    id: "codexSize",
    label: "Codex size",
    description: "Default size for provider=codex",
    values: () => [
      defaultTag(DEFAULT_CODEX_SIZE),
      "auto",
      "1K",
      "1024x1024",
      "1536x1024",
      "1024x1536",
    ],
    get: (c) =>
      c.codexSize === undefined || c.codexSize === DEFAULT_CODEX_SIZE
        ? defaultTag(DEFAULT_CODEX_SIZE)
        : c.codexSize,
    apply: (c, v) => {
      if (isDefaultTag(v)) delete c.codexSize;
      else c.codexSize = v;
    },
  },
];

const TEXT_FIELDS: TextField[] = [
  {
    id: "xaiModel",
    label: "xAI model",
    description: "Default xAI Imagine model",
    defaultDisplay: DEFAULT_XAI_MODEL,
    get: (c) => c.xaiModel,
    apply: (c, v) => {
      if (v) c.xaiModel = v;
      else delete c.xaiModel;
    },
  },
  {
    id: "codexModel",
    label: "Codex model alias",
    description:
      "codex-2 / codex-2.5 aliases or gpt-image-2 / 2.5 model ids; unsupported ids are rejected",
    defaultDisplay: DEFAULT_CODEX_MODEL,
    get: (c) => c.codexModel,
    apply: (c, v) => {
      if (v) c.codexModel = v;
      else delete c.codexModel;
    },
  },
];

function textDisplay(field: TextField, cfg: PiImagenConfig): string {
  return field.get(cfg) ?? defaultTag(field.defaultDisplay);
}

export function registerSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Configure pi-imagen-tools (default provider, Codex quality/size, models).",
    getArgumentCompletions(prefix) {
      const lower = prefix.toLowerCase();
      const matches = SUBCOMMANDS.filter((name) => name.startsWith(lower));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      try {
        if (!trimmed) {
          if (ctx.mode === "tui") {
            await openSettingsMenu(ctx);
            return;
          }
          await printStatus(ctx);
          return;
        }
        if (trimmed === "status") {
          await printStatus(ctx);
          return;
        }
        if (trimmed === "reset") {
          if (ctx.hasUI) {
            await openResetMenu(ctx, isProjectTrustedContext(ctx));
          } else {
            notify(
              ctx,
              "`reset` requires interactive mode. Delete the config files manually.",
              "warning",
            );
          }
          return;
        }
        notify(
          ctx,
          `Unknown subcommand: ${trimmed}. Expected: ${SUBCOMMANDS.join(", ")}.`,
          "error",
        );
      } catch (error) {
        notify(ctx, (error as Error).message, "error");
      }
    },
  });
}

async function openSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const isProjectTrusted = isProjectTrustedContext(ctx);
  const resolved = await loadConfig(ctx.cwd, isProjectTrusted);
  const drafts: Record<ConfigScope, PiImagenConfig> = {
    project: { ...resolved.sources.project },
    home: { ...resolved.sources.home },
  };
  let scope: ConfigScope = isProjectTrusted ? "project" : "home";
  let dirty = false;
  let saveQueue: Promise<void> = Promise.resolve();

  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const settingsTheme = buildSettingsTheme(theme);
    let list: SettingsList;

    const refreshDisplays = () => {
      scopeItem.description = formatScopeDescription(scope, ctx.cwd);
      for (const f of CYCLE_FIELDS) {
        const item = items.find((candidate) => candidate.id === f.id);
        if (item) item.values = f.values(drafts[scope]);
        list.updateValue(f.id, f.get(drafts[scope]));
      }
      for (const f of TEXT_FIELDS) list.updateValue(f.id, textDisplay(f, drafts[scope]));
      list.invalidate();
    };

    const save = () => {
      if (scope === "project" && !isProjectTrusted) {
        ctx.ui.notify("Project config cannot be saved until the project is trusted.", "warning");
        return;
      }
      const currentScope = scope;
      const currentDraft = { ...drafts[scope] };
      saveQueue = saveQueue
        .catch(() => undefined)
        .then(async () => {
          try {
            await saveConfig(currentScope, ctx.cwd, currentDraft);
            dirty = true;
          } catch (error: unknown) {
            ctx.ui.notify((error as Error).message, "error");
          }
        });
    };

    const onChange = (id: string, newValue: string) => {
      if (id === "scope") {
        scope = newValue as ConfigScope;
        refreshDisplays();
        return;
      }
      const cycle = CYCLE_FIELDS.find((f) => f.id === id);
      if (cycle) {
        cycle.apply(drafts[scope], newValue);
        refreshDisplays();
        save();
        return;
      }
      const text = TEXT_FIELDS.find((f) => f.id === id);
      if (text) {
        try {
          text.apply(drafts[scope], newValue.trim());
        } catch (error: unknown) {
          ctx.ui.notify((error as Error).message, "error");
          list.updateValue(id, textDisplay(text, drafts[scope]));
          return;
        }
        list.updateValue(id, textDisplay(text, drafts[scope]));
        save();
      }
    };

    const scopeItem: SettingItem = {
      id: "scope",
      label: "Config scope",
      description: isProjectTrusted
        ? formatScopeDescription(scope, ctx.cwd)
        : "Project config disabled until the project is trusted; editing home config only",
      currentValue: scope,
      values: isProjectTrusted ? ["project", "home"] : ["home"],
    };

    const items: SettingItem[] = [
      scopeItem,
      ...CYCLE_FIELDS.map(
        (f): SettingItem => ({
          id: f.id,
          label: f.label,
          description: f.description,
          currentValue: f.get(drafts[scope]),
          values: f.values(drafts[scope]),
        }),
      ),
      ...TEXT_FIELDS.map(
        (f): SettingItem => ({
          id: f.id,
          label: f.label,
          description: f.description,
          currentValue: textDisplay(f, drafts[scope]),
          submenu: (_current, submenuDone) => {
            const input = new Input();
            input.setValue(f.get(drafts[scope]) ?? "");
            input.onSubmit = (value) => submenuDone(value);
            input.onEscape = () => submenuDone();
            return input;
          },
        }),
      ),
    ];

    list = new SettingsList(items, items.length, settingsTheme, onChange, () => done(), {
      enableSearch: true,
    });
    return list as Component;
  });

  await saveQueue;
  if (dirty && typeof ctx.reload === "function") await ctx.reload();
}

function buildSettingsTheme(theme: Theme) {
  return {
    label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
    value: (text: string, selected: boolean) =>
      selected ? theme.bold(theme.fg("accent", text)) : theme.fg("muted", text),
    description: (text: string) => theme.fg("dim", text),
    cursor: theme.fg("accent", "> "),
    hint: (text: string) => theme.fg("dim", text),
  };
}

async function openResetMenu(
  ctx: ExtensionCommandContext,
  isProjectTrusted: boolean,
): Promise<boolean> {
  let removed = false;

  while (true) {
    const options = [
      ...(isProjectTrusted
        ? [`Delete project config (${relative(ctx.cwd, getConfigPath("project", ctx.cwd))})`]
        : []),
      `Delete home config (${homeRelative(getConfigPath("home", ctx.cwd))})`,
      "Back",
    ];
    const choice = await ctx.ui.select("Reset configuration", options);

    if (!choice || choice === "Back") return removed;

    const scope: ConfigScope = choice.startsWith("Delete project") ? "project" : "home";
    const filePath = getConfigPath(scope, ctx.cwd);
    const confirmed = await ctx.ui.confirm("Delete config", `Remove ${filePath}?`);
    if (!confirmed) continue;
    try {
      const deleted = await deleteConfig(scope, ctx.cwd);
      if (deleted) {
        ctx.ui.notify(`Deleted ${filePath}.`);
        removed = true;
      } else {
        ctx.ui.notify(`${filePath} did not exist.`, "warning");
      }
    } catch (error) {
      ctx.ui.notify(`Failed to delete ${filePath}: ${(error as Error).message}`, "error");
    }
  }
}

async function printStatus(ctx: ExtensionCommandContext): Promise<void> {
  const resolved = await loadConfig(ctx.cwd, isProjectTrustedContext(ctx));
  notify(ctx, formatStatus(resolved, ctx.cwd));
}

function formatScopeDescription(scope: ConfigScope, cwd: string): string {
  const filePath = getConfigPath(scope, cwd);
  const displayPath = scope === "home" ? homeRelative(filePath) : relative(cwd, filePath);
  return `Writes to the ${scope} config file: ${displayPath}`;
}

function homeRelative(filePath: string): string {
  const home = process.env.HOME ?? "";
  return home && filePath.startsWith(`${home}/`)
    ? `~/${filePath.slice(home.length + 1)}`
    : filePath;
}

function notify(
  ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  if (level === "error") console.error(message);
  else console.log(message);
}

/** Exported for tests. */
export function statusText(resolved: ResolvedImagenConfig, cwd: string): string {
  return formatStatus(resolved, cwd);
}
