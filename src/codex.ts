import {
  CODEX_BASE_URL,
  CODEX_DEFAULT_ALIAS,
  CODEX_IMAGE_MODEL,
  CODEX_MAX_EDIT_IMAGES,
  CODEX_ORIGINATOR,
  IMAGE_GEN_TIMEOUT_MS,
  MAX_IMAGE_N,
  USER_AGENT,
} from "./constants.ts";
import { resolveImagineImageRef, saveB64ToPath } from "./imagine.ts";
import { clampN, expandOutputPaths } from "./paths.ts";

/** Official ImageQuality enum + legacy medium default via aliases. */
export type CodexQuality = "low" | "medium" | "high" | "auto";
export type CodexBackground = "transparent" | "opaque" | "auto";

const ALIASES: Record<string, string> = {
  "codex-2": "gpt-image-2-medium",
  "codex-2-low": "gpt-image-2-low",
  "codex-2-medium": "gpt-image-2-medium",
  "codex-2-high": "gpt-image-2-high",
  "gpt-image-2": "gpt-image-2",
  "gpt-image-2-low": "gpt-image-2-low",
  "gpt-image-2-medium": "gpt-image-2-medium",
  "gpt-image-2-high": "gpt-image-2-high",
};

const TIER_QUALITY: Record<string, CodexQuality> = {
  "gpt-image-2": "auto",
  "gpt-image-2-low": "low",
  "gpt-image-2-medium": "medium",
  "gpt-image-2-high": "high",
};

export type CodexCredential = { apiKey: string; accountId: string };

export type GenerateCodexParams = {
  prompt: string;
  output_path: string;
  model?: string;
  quality?: string;
  aspect_ratio?: string;
  size?: string;
  background?: string;
  n?: number;
};

export type EditCodexParams = GenerateCodexParams & {
  images: string[];
};

export type CodexImageResult = {
  paths: string[];
  model: string;
  n: number;
  quality: CodexQuality;
  size: string;
  background: CodexBackground;
  warnings: string[];
};

export type CodexApiResponse = {
  created?: number;
  data?: Array<{ b64_json?: string }>;
  quality?: string;
  size?: string;
  background?: string;
};

export function resolveCodexAlias(input: string | undefined): string {
  const raw = (input ?? CODEX_DEFAULT_ALIAS).trim() || CODEX_DEFAULT_ALIAS;
  return ALIASES[raw] ?? raw;
}

/** Always send official API model `gpt-image-2`; tier aliases only affect quality. */
export function resolveCodexApiModel(_aliasOrModel?: string): string {
  return CODEX_IMAGE_MODEL;
}

export function resolveCodexQuality(modelId: string, qualityOverride?: string): CodexQuality {
  const override = qualityOverride?.trim().toLowerCase();
  if (override === "low" || override === "medium" || override === "high" || override === "auto") {
    return override;
  }
  const fromTier = TIER_QUALITY[modelId];
  if (fromTier) return fromTier;
  if (modelId.endsWith("-low")) return "low";
  if (modelId.endsWith("-high")) return "high";
  if (modelId.endsWith("-medium")) return "medium";
  return "auto";
}

export function resolveCodexBackground(value?: string): CodexBackground {
  const v = value?.trim().toLowerCase();
  if (v === "transparent" || v === "opaque" || v === "auto") return v;
  if (!v) return "auto";
  throw new Error(`background must be transparent|opaque|auto, got ${value}`);
}

/**
 * Map size/aspect to Codex Images size.
 * Official default is `auto` when neither size nor aspect is given.
 * gpt-image-2 accepts any WIDTHxHEIGHT with edges <= 3840px, both edges
 * multiples of 16, ratio <= 3:1, and 655,360–8,294,400 total pixels
 * (codex imagegen skill references/image-api.md).
 */
export function mapCodexSize(
  size?: string,
  aspectRatio?: string,
): { size: string; warnings: string[] } {
  const warnings: string[] = [];
  const landscape = new Set(["16:9", "4:3", "3:2", "21:9", "2:1", "20:9", "19.5:9"]);
  const portrait = new Set(["9:16", "3:4", "2:3", "1:4", "1:8", "1:2"]);
  const isLandscape = aspectRatio ? landscape.has(aspectRatio) : false;
  const isPortrait = aspectRatio ? portrait.has(aspectRatio) : false;

  const oriented = (square: string, land: string, port: string): string => {
    if (isLandscape) return land;
    if (isPortrait) return port;
    return square;
  };

  const normalized = (size ?? "").trim();
  switch (normalized) {
    case "auto":
      return { size: "auto", warnings };
    case "512":
      warnings.push("size 512 below the 655,360-pixel minimum, using 1024x1024");
      return { size: "1024x1024", warnings };
    case "1K":
      return { size: oriented("1024x1024", "1536x1024", "1024x1536"), warnings };
    case "2K":
      return { size: oriented("2048x2048", "2048x1152", "1152x2048"), warnings };
    case "4K":
      if (isLandscape) return { size: "3840x2160", warnings };
      if (isPortrait) return { size: "2160x3840", warnings };
      warnings.push("size 4K square exceeds the 8,294,400-pixel cap, using max square 2880x2880");
      return { size: "2880x2880", warnings };
    case "":
      if (isLandscape || isPortrait) {
        return { size: oriented("1024x1024", "1536x1024", "1024x1536"), warnings };
      }
      // Match official imagegen tool default.
      return { size: "auto", warnings };
    default:
      // Explicit WIDTHxHEIGHT passes through; the backend enforces the
      // gpt-image-2 size constraints.
      return { size: normalized, warnings };
  }
}

function codexHeaders(credential: CodexCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.apiKey}`,
    "chatgpt-account-id": credential.accountId,
    Accept: "application/json",
    "Content-Type": "application/json",
    originator: CODEX_ORIGINATOR,
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
  };
}

const CODEX_ACTIVE_LIMIT_HEADER = "x-codex-active-limit";

/**
 * Mirror codex-rs map_api_error: surface usage-limit failures (429 with
 * `error.type == "usage_limit_reached"`) with the active limit id and reset
 * time instead of a raw truncated body.
 */
export function describeCodexHttpError(status: number, body: string, headers: Headers): string {
  const fallback = `Codex Images API HTTP ${status}: ${body.slice(0, 400)}`;
  let parsed: {
    error?: { type?: unknown; message?: unknown; resets_at?: unknown };
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return fallback;
  }
  const error = parsed?.error;
  const errorType = typeof error?.type === "string" ? error.type : undefined;
  if (status === 429 && errorType === "usage_limit_reached") {
    const limit = headers.get(CODEX_ACTIVE_LIMIT_HEADER)?.trim();
    const limitText = limit ? ` (limit: ${limit})` : "";
    const resetsAt = typeof error?.resets_at === "number" ? error.resets_at : undefined;
    const resetText = resetsAt
      ? `; limit resets at ${new Date(resetsAt * 1000).toISOString()}`
      : "";
    return `Codex Images API usage limit reached${limitText}${resetText}. Do not retry until the limit resets.`;
  }
  if (status === 429 && errorType === "usage_not_included") {
    return "Codex Images API: image generation is not included in the current plan (usage_not_included).";
  }
  const message =
    typeof error?.message === "string" && error.message.trim() ? error.message : undefined;
  if (message) return `Codex Images API HTTP ${status}: ${message}`;
  return fallback;
}

export async function postCodexImages(
  credential: CodexCredential,
  path: "/images/generations" | "/images/edits",
  body: Record<string, unknown>,
  opts?: { baseUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number },
): Promise<CodexApiResponse> {
  const baseUrl = (opts?.baseUrl ?? CODEX_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? IMAGE_GEN_TIMEOUT_MS;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: codexHeaders(credential),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(describeCodexHttpError(res.status, text, res.headers));
    }
    return (await res.json()) as CodexApiResponse;
  } catch (error) {
    if (controller.signal.aborted && opts?.signal?.aborted) {
      throw new Error("Image request cancelled");
    }
    if (controller.signal.aborted) {
      throw new Error(`Image request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}

function extractB64List(json: CodexApiResponse, expected: number): string[] {
  const items = json.data ?? [];
  const b64s = items
    .map((item) => item.b64_json)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (b64s.length === 0) {
    throw new Error("Codex Images API returned no b64_json data");
  }
  if (b64s.length < expected) {
    throw new Error(`Codex Images API returned ${b64s.length} image(s), expected ${expected}`);
  }
  return b64s.slice(0, expected);
}

const QUALITY_VALUES: readonly CodexQuality[] = ["low", "medium", "high", "auto"];
const BACKGROUND_VALUES: readonly CodexBackground[] = ["transparent", "opaque", "auto"];

function echoOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Prefer the response-echoed quality/size/background over request-side values. */
function echoedMeta(
  json: CodexApiResponse,
  common: { quality: CodexQuality; size: string; background: CodexBackground },
): { quality: CodexQuality; size: string; background: CodexBackground } {
  return {
    quality: echoOr(json.quality, QUALITY_VALUES, common.quality),
    size: typeof json.size === "string" && json.size.trim() ? json.size : common.size,
    background: echoOr(json.background, BACKGROUND_VALUES, common.background),
  };
}

function buildCommonFields(params: {
  prompt: string;
  model: string;
  quality: CodexQuality;
  size: string;
  background: CodexBackground;
  n: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    model: params.model,
  };
  if (params.n !== 1) body.n = params.n;
  if (params.quality) body.quality = params.quality;
  if (params.size) body.size = params.size;
  if (params.background) body.background = params.background;
  return body;
}

function prepareCommon(params: GenerateCodexParams): {
  prompt: string;
  n: number;
  alias: string;
  apiModel: string;
  quality: CodexQuality;
  size: string;
  background: CodexBackground;
  warnings: string[];
} {
  const prompt = params.prompt?.trim();
  if (!prompt) throw new Error("prompt is required");
  const n = clampN(params.n, MAX_IMAGE_N);
  const alias = resolveCodexAlias(params.model);
  const apiModel = resolveCodexApiModel(alias);
  const quality = resolveCodexQuality(alias, params.quality);
  const { size, warnings } = mapCodexSize(params.size, params.aspect_ratio);
  const background = resolveCodexBackground(params.background);
  return { prompt, n, alias, apiModel, quality, size, background, warnings };
}

function saveAll(b64s: string[], outputPath: string, n: number, cwd: string): string[] {
  const outputPaths = expandOutputPaths(outputPath, n, cwd, ".png", true);
  return b64s.map((b64, i) => saveB64ToPath(b64, outputPaths[i]!));
}

/** Official: POST /images/generations */
export async function generateCodexImages(
  credential: CodexCredential,
  params: GenerateCodexParams,
  opts?: { cwd?: string; baseUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<CodexImageResult> {
  const common = prepareCommon(params);
  const cwd = opts?.cwd ?? process.cwd();
  const body = buildCommonFields({
    prompt: common.prompt,
    model: common.apiModel,
    quality: common.quality,
    size: common.size,
    background: common.background,
    n: common.n,
  });

  const json = await postCodexImages(credential, "/images/generations", body, opts);
  const b64s = extractB64List(json, common.n);
  const paths = saveAll(b64s, params.output_path, common.n, cwd);
  const meta = echoedMeta(json, common);

  return {
    paths,
    model: params.model?.trim() || CODEX_DEFAULT_ALIAS,
    n: common.n,
    quality: meta.quality,
    size: meta.size,
    background: meta.background,
    warnings: common.warnings,
  };
}

/** Official: POST /images/edits — max 5 reference images. */
export async function editCodexImages(
  credential: CodexCredential,
  params: EditCodexParams,
  opts?: { cwd?: string; baseUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<CodexImageResult> {
  const common = prepareCommon(params);
  const cwd = opts?.cwd ?? process.cwd();
  const refs = (params.images ?? []).map((s) => s?.trim()).filter(Boolean) as string[];
  if (!refs.length) throw new Error("images requires at least one reference image");
  if (refs.length > CODEX_MAX_EDIT_IMAGES) {
    throw new Error(`codex image_edit supports at most ${CODEX_MAX_EDIT_IMAGES} reference images`);
  }

  const images = refs.map((ref) => ({
    image_url: resolveImagineImageRef(ref, cwd),
  }));

  const body = {
    ...buildCommonFields({
      prompt: common.prompt,
      model: common.apiModel,
      quality: common.quality,
      size: common.size,
      background: common.background,
      n: common.n,
    }),
    images,
  };

  const json = await postCodexImages(credential, "/images/edits", body, opts);
  const b64s = extractB64List(json, common.n);
  const paths = saveAll(b64s, params.output_path, common.n, cwd);
  const meta = echoedMeta(json, common);

  return {
    paths,
    model: params.model?.trim() || CODEX_DEFAULT_ALIAS,
    n: common.n,
    quality: meta.quality,
    size: meta.size,
    background: meta.background,
    warnings: common.warnings,
  };
}
