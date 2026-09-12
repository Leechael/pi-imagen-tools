import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ImageProviderId } from "./constants.ts";
import { CODEX_DEFAULT_ALIAS, XAI_IMAGINE_MODEL } from "./constants.ts";
import { resolveCodexApiModel } from "./codex.ts";

export type ConfigScope = "project" | "home";

export type CodexQualitySetting = "auto" | "low" | "medium" | "high";
export type CodexBackgroundSetting = "auto" | "opaque" | "transparent";

export interface PiImagenConfig {
  /** Default backend when tool omits provider and model does not imply one. */
  defaultProvider?: ImageProviderId;
  /** xAI model id default for image_gen; image_edit always uses the quality model. */
  xaiModel?: string;
  /** Codex alias or model id (codex-2, codex-2.5-flare, gpt-image-2.5-sunburst, …); gpt-image-2 and newer. */
  codexModel?: string;
  codexQuality?: CodexQualitySetting;
  /** auto | 1K | 2K | 4K | 1024x1024 | … */
  codexSize?: string;
  codexBackground?: CodexBackgroundSetting;
}

export interface ResolvedImagenConfig {
  defaultProvider: ImageProviderId;
  xaiModel: string;
  codexModel: string;
  codexApiModel: string;
  codexQuality: CodexQualitySetting;
  codexSize: string;
  codexBackground: CodexBackgroundSetting;
  sources: {
    project?: PiImagenConfig;
    home?: PiImagenConfig;
    env?: PiImagenConfig;
  };
}

export const CONFIG_FILE_NAME = "pi-imagen-tools.json";

export const DEFAULT_PROVIDER: ImageProviderId = "xai";
export const DEFAULT_XAI_MODEL = XAI_IMAGINE_MODEL;
export const DEFAULT_CODEX_MODEL = CODEX_DEFAULT_ALIAS;
export const DEFAULT_CODEX_QUALITY: CodexQualitySetting = "auto";
export const DEFAULT_CODEX_SIZE = "auto";
export const DEFAULT_CODEX_BACKGROUND: CodexBackgroundSetting = "auto";

const PROVIDERS: readonly ImageProviderId[] = ["xai", "codex"] as const;
const QUALITIES: readonly CodexQualitySetting[] = ["auto", "low", "medium", "high"] as const;
const BACKGROUNDS: readonly CodexBackgroundSetting[] = ["auto", "opaque", "transparent"] as const;

export function getConfigPath(scope: ConfigScope, cwd: string): string {
  if (scope === "project") return join(cwd, ".pi", CONFIG_FILE_NAME);
  return join(homedir(), ".pi", CONFIG_FILE_NAME);
}

export function isProjectTrustedContext(ctx: unknown): boolean {
  if (ctx === null || ctx === undefined || typeof ctx !== "object") return true;
  const maybe = ctx as { isProjectTrusted?: unknown };
  if (typeof maybe.isProjectTrusted === "boolean") return maybe.isProjectTrusted;
  if (typeof maybe.isProjectTrusted !== "function") return true;
  try {
    return Boolean(maybe.isProjectTrusted());
  } catch {
    return false;
  }
}

export async function loadConfig(
  cwd: string,
  isProjectTrusted = true,
): Promise<ResolvedImagenConfig> {
  const homeConfig = await readConfigFile(getConfigPath("home", cwd));
  const projectConfig = isProjectTrusted
    ? await readConfigFile(getConfigPath("project", cwd))
    : undefined;
  const envConfig = readEnvConfig();

  const merged: PiImagenConfig = {
    ...homeConfig,
    ...projectConfig,
    ...envConfig,
  };

  const resolved: ResolvedImagenConfig = {
    defaultProvider: merged.defaultProvider ?? DEFAULT_PROVIDER,
    xaiModel: merged.xaiModel ?? DEFAULT_XAI_MODEL,
    codexModel: merged.codexModel ?? DEFAULT_CODEX_MODEL,
    codexApiModel: resolveCodexApiModel(merged.codexModel ?? DEFAULT_CODEX_MODEL),
    codexQuality: merged.codexQuality ?? DEFAULT_CODEX_QUALITY,
    codexSize: merged.codexSize ?? DEFAULT_CODEX_SIZE,
    codexBackground: merged.codexBackground ?? DEFAULT_CODEX_BACKGROUND,
    sources: {},
  };
  if (homeConfig) resolved.sources.home = homeConfig;
  if (projectConfig) resolved.sources.project = projectConfig;
  if (envConfig && Object.keys(envConfig).length > 0) resolved.sources.env = envConfig;
  return resolved;
}

export async function saveConfig(
  scope: ConfigScope,
  cwd: string,
  config: PiImagenConfig,
): Promise<string> {
  validateConfig(config, `<save:${scope}>`);
  const filePath = getConfigPath(scope, cwd);
  const clean = stripUndefined({ ...config } as Record<string, unknown>);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(clean, null, 2)}\n`, "utf-8");
  return filePath;
}

export async function deleteConfig(scope: ConfigScope, cwd: string): Promise<boolean> {
  const filePath = getConfigPath(scope, cwd);
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readConfigFile(filePath: string): Promise<PiImagenConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Failed to read ${filePath}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid config in ${filePath}: expected a JSON object`);
  }
  const config = parsed as PiImagenConfig;
  validateConfig(config, filePath);
  return config;
}

function readEnvConfig(): PiImagenConfig | undefined {
  const env: PiImagenConfig = {};
  const defaultProvider = trimmedEnv("PI_IMAGEN_DEFAULT_PROVIDER");
  if (defaultProvider !== undefined) env.defaultProvider = defaultProvider as ImageProviderId;
  const xaiModel = trimmedEnv("PI_IMAGEN_XAI_MODEL");
  if (xaiModel !== undefined) env.xaiModel = xaiModel;
  const codexModel = trimmedEnv("PI_IMAGEN_CODEX_MODEL");
  if (codexModel !== undefined) env.codexModel = codexModel;
  const codexQuality = trimmedEnv("PI_IMAGEN_CODEX_QUALITY");
  if (codexQuality !== undefined) env.codexQuality = codexQuality as CodexQualitySetting;
  const codexSize = trimmedEnv("PI_IMAGEN_CODEX_SIZE");
  if (codexSize !== undefined) env.codexSize = codexSize;
  const codexBackground = trimmedEnv("PI_IMAGEN_CODEX_BACKGROUND");
  if (codexBackground !== undefined) {
    env.codexBackground = codexBackground as CodexBackgroundSetting;
  }
  if (Object.keys(env).length === 0) return undefined;
  validateConfig(env, "<env>");
  return env;
}

export function validateConfig(config: PiImagenConfig, sourceLabel: string): void {
  if (config.defaultProvider !== undefined && !PROVIDERS.includes(config.defaultProvider)) {
    throw new Error(
      `Invalid defaultProvider in ${sourceLabel}: ${JSON.stringify(config.defaultProvider)}. Allowed: ${PROVIDERS.join(", ")}.`,
    );
  }
  if (config.xaiModel !== undefined && !isNonEmptyString(config.xaiModel)) {
    throw new Error(`Invalid xaiModel in ${sourceLabel}: must be a non-empty string.`);
  }
  if (config.codexModel !== undefined && !isNonEmptyString(config.codexModel)) {
    throw new Error(`Invalid codexModel in ${sourceLabel}: must be a non-empty string.`);
  }
  if (config.codexQuality !== undefined && !QUALITIES.includes(config.codexQuality)) {
    throw new Error(
      `Invalid codexQuality in ${sourceLabel}: ${JSON.stringify(config.codexQuality)}. Allowed: ${QUALITIES.join(", ")}.`,
    );
  }
  if (config.codexSize !== undefined && !isNonEmptyString(config.codexSize)) {
    throw new Error(`Invalid codexSize in ${sourceLabel}: must be a non-empty string.`);
  }
  if (config.codexBackground !== undefined && !BACKGROUNDS.includes(config.codexBackground)) {
    throw new Error(
      `Invalid codexBackground in ${sourceLabel}: ${JSON.stringify(config.codexBackground)}. Allowed: ${BACKGROUNDS.join(", ")}.`,
    );
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function trimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function formatStatus(resolved: ResolvedImagenConfig, cwd: string): string {
  const lines = ["pi-imagen-tools settings:"];
  lines.push(`  defaultProvider  = ${resolved.defaultProvider}`);
  lines.push(`  xaiModel         = ${resolved.xaiModel}`);
  lines.push(`  codexModel       = ${resolved.codexModel}`);
  lines.push(`  codexApiModel    = ${resolved.codexApiModel}`);
  lines.push(`  codexQuality     = ${resolved.codexQuality}`);
  lines.push(`  codexSize        = ${resolved.codexSize}`);
  lines.push(`  codexBackground  = ${resolved.codexBackground}`);
  lines.push("");
  lines.push("Sources (env > project > home):");
  lines.push(`  env     = ${describeSource(resolved.sources.env)}`);
  lines.push(
    `  project = ${describeSource(resolved.sources.project)} (${getConfigPath("project", cwd)})`,
  );
  lines.push(
    `  home    = ${describeSource(resolved.sources.home)} (${getConfigPath("home", cwd)})`,
  );
  return lines.join("\n");
}

function describeSource(config: PiImagenConfig | undefined): string {
  if (!config) return "(none)";
  const keys = Object.keys(config);
  if (keys.length === 0) return "(empty)";
  return keys.sort().join(", ");
}
