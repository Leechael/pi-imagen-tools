import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  IMAGE_GEN_TIMEOUT_MS,
  MAX_IMAGE_N,
  USER_AGENT,
  XAI_IMAGINE_BASE_URL,
  XAI_IMAGINE_MODEL,
} from "./constants.ts";
import { clampN, expandOutputPaths } from "./paths.ts";

export type ImagineResponse = {
  data?: Array<{ b64_json?: string }>;
};

export type GenerateImageParams = {
  prompt: string;
  output_path: string;
  aspect_ratio?: string;
  model?: string;
  n?: number;
};

export type EditImageParams = {
  prompt: string;
  images: string[];
  output_path: string;
  aspect_ratio?: string;
  model?: string;
  n?: number;
};

function requestHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
}

export async function postImagine(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  opts?: { baseUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number },
): Promise<ImagineResponse> {
  const baseUrl = (opts?.baseUrl ?? XAI_IMAGINE_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? IMAGE_GEN_TIMEOUT_MS;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: requestHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Imagine API HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    return (await res.json()) as ImagineResponse;
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

export function saveB64ToPath(b64: string, outputPath: string): string {
  const dir = dirname(outputPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, Buffer.from(b64, "base64"));
  return outputPath;
}

const IMAGE_TOOL_NAMES = new Set(["image_gen", "image_edit"]);
const ATTACHMENT_TOKEN_RE = /^\[?image\s*#(\d+)\]?$/i;

function imageContentRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const part = value as { type?: unknown; data?: unknown; mimeType?: unknown };
  if (
    part.type !== "image" ||
    typeof part.data !== "string" ||
    !part.data ||
    typeof part.mimeType !== "string" ||
    !part.mimeType.startsWith("image/")
  ) {
    return undefined;
  }
  return `data:${part.mimeType};base64,${part.data}`;
}

function imageRefsFromMessage(message: unknown, cwd: string): string[] {
  if (!message || typeof message !== "object") return [];
  const msg = message as {
    role?: unknown;
    toolName?: unknown;
    content?: unknown;
    details?: unknown;
  };
  const content = Array.isArray(msg.content) ? msg.content : [];
  const inline = content.map(imageContentRef).filter((v): v is string => !!v);
  if (msg.role !== "toolResult" || !IMAGE_TOOL_NAMES.has(String(msg.toolName))) return inline;

  const paths: string[] = [];
  const details = msg.details && typeof msg.details === "object"
    ? (msg.details as { paths?: unknown; path?: unknown })
    : undefined;
  if (Array.isArray(details?.paths)) {
    paths.push(...details.paths.filter((v): v is string => typeof v === "string"));
  } else if (typeof details?.path === "string") {
    paths.push(details.path);
  }
  if (paths.length === 0) {
    for (const part of content) {
      if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      for (const line of text.split("\n")) {
        const matched = line.match(/^Saved (?:edited )?images?(?: \(\d+\))?:\s*(.+)$/);
        if (matched?.[1]) paths.push(matched[1].trim());
        const listPath = line.match(/^-\s+(.+)$/)?.[1]?.trim();
        if (listPath) paths.push(listPath);
      }
    }
  }
  return [...inline, ...paths]
    .map((value) => (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)
      ? value
      : isAbsolute(value)
        ? value
        : resolve(cwd, value)))
    .filter((value) => /^data:image\//i.test(value) || /^https?:\/\//i.test(value) || existsSync(value));
}

function branchMessages(entries: unknown[]): unknown[] {
  return entries
    .map((entry) =>
      entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message"
        ? (entry as { message?: unknown }).message
        : undefined)
    .filter((message) => !!message);
}

export function recentConversationImageRefs(
  entries: unknown[],
  count: number,
  cwd = process.cwd(),
): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw new Error("num_last_images_to_include must be between 1 and 5");
  }
  const found: string[] = [];
  for (const message of branchMessages(entries).reverse()) {
    for (const ref of imageRefsFromMessage(message, cwd).reverse()) {
      if (!found.includes(ref)) found.push(ref);
      if (found.length === count) return found.reverse();
    }
  }
  throw new Error(`requested the last ${count} conversation images, but only ${found.length} were available`);
}

export function resolveRequestedImageRefs(
  images: string[],
  entries: unknown[],
  cwd = process.cwd(),
): string[] {
  const latestUserImages = branchMessages(entries)
    .reverse()
    .find((message) =>
      !!message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "user" &&
      imageRefsFromMessage(message, cwd).length > 0);
  const attached = latestUserImages ? imageRefsFromMessage(latestUserImages, cwd) : [];
  return images.map((value) => {
    const match = value.trim().match(ATTACHMENT_TOKEN_RE);
    if (!match) return value;
    const ref = attached[Number(match[1]) - 1];
    if (!ref) throw new Error(`image reference ${JSON.stringify(value)} matches no image attached to the latest user message`);
    return ref;
  });
}

export function detectImageMime(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const ascii = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/**
 * Resolve one image_edit reference to an API-safe URL (https or data URI).
 * Local paths and file:// become data:image/...;base64,...
 */
export function resolveImagineImageRef(value: string, cwd = process.cwd()): string {
  const cleaned = value.trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned) throw new Error("empty image reference");
  if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) return cleaned;

  let filePath = cleaned;
  if (cleaned.startsWith("file://")) {
    try {
      filePath = fileURLToPath(cleaned);
    } catch {
      throw new Error(`invalid file:// image reference: ${cleaned}`);
    }
  } else if (!isAbsolute(filePath)) {
    filePath = resolve(cwd, filePath);
  }

  if (!existsSync(filePath)) {
    throw new Error(`image reference not readable: ${cleaned}`);
  }

  const bytes = readFileSync(filePath);
  if (bytes.length === 0) throw new Error(`image reference contained no data: ${cleaned}`);
  const mime = detectImageMime(bytes);
  if (!mime) {
    const ext = extname(filePath).toLowerCase();
    throw new Error(`unsupported or invalid image type for image_edit: ${ext || "(none)"}`);
  }

  return `data:${mime};base64,${bytes.toString("base64")}`;
}

const XAI_MAX_REFERENCE_BYTES = 400 * 1024;
const XAI_MAX_REFERENCE_DIMENSION = 768;
const XAI_MAX_REFERENCE_PIXELS = 12_000_000;
const XAI_REFERENCE_QUALITY_STEPS = [80, 65, 50, 35] as const;

function decodeImageDataUri(value: string): Buffer {
  const comma = value.indexOf(",");
  if (comma < 0 || !value.slice(0, comma).includes(";base64")) {
    throw new Error("image references only support base64 data URIs");
  }
  const bytes = Buffer.from(value.slice(comma + 1), "base64");
  if (bytes.length === 0) throw new Error("image reference contained no data");
  return bytes;
}

/** Match grok-build image_edit preprocessing: validate and compress large refs. */
export async function resolveXaiImageRef(value: string, cwd = process.cwd()): Promise<string> {
  const resolved = resolveImagineImageRef(value, cwd);
  if (/^https?:\/\//i.test(resolved)) return resolved;

  const raw = decodeImageDataUri(resolved);
  const sourceMime = detectImageMime(raw);
  if (!sourceMime) throw new Error("could not detect image format for reference");
  if (raw.length <= XAI_MAX_REFERENCE_BYTES && (sourceMime === "image/jpeg" || sourceMime === "image/png")) {
    return `data:${sourceMime};base64,${raw.toString("base64")}`;
  }

  const base = sharp(raw, { limitInputPixels: XAI_MAX_REFERENCE_PIXELS })
    .rotate()
    .resize({
      width: XAI_MAX_REFERENCE_DIMENSION,
      height: XAI_MAX_REFERENCE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });
  for (const quality of XAI_REFERENCE_QUALITY_STEPS) {
    const encoded = await base.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (encoded.length <= XAI_MAX_REFERENCE_BYTES) {
      return `data:image/jpeg;base64,${encoded.toString("base64")}`;
    }
  }
  throw new Error("could not compress image reference below the 400KB Imagine limit");
}

function extractB64List(json: ImagineResponse, expected: number): string[] {
  const items = json.data ?? [];
  const b64s = items.map((item) => item.b64_json).filter((v): v is string => typeof v === "string" && v.length > 0);
  if (b64s.length === 0) {
    throw new Error("Imagine API returned no b64_json data");
  }
  if (b64s.length < expected) {
    throw new Error(`Imagine API returned ${b64s.length} image(s), expected ${expected}`);
  }
  return b64s.slice(0, expected);
}

export async function generateImages(
  apiKey: string,
  params: GenerateImageParams,
  opts?: { cwd?: string; baseUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<{ paths: string[]; model: string; n: number }> {
  const prompt = params.prompt?.trim();
  if (!prompt) throw new Error("prompt is required");
  const n = clampN(params.n, MAX_IMAGE_N);
  const model = params.model?.trim() || XAI_IMAGINE_MODEL;
  const cwd = opts?.cwd ?? process.cwd();
  const outputPaths = expandOutputPaths(params.output_path, n, cwd, ".jpg", true);

  const json = await postImagine(
    apiKey,
    "/images/generations",
    {
      model,
      prompt,
      n,
      aspect_ratio: params.aspect_ratio?.trim() || "auto",
      resolution: "1k",
      response_format: "b64_json",
    },
    opts,
  );

  const b64s = extractB64List(json, n);
  const paths = b64s.map((b64, i) => saveB64ToPath(b64, outputPaths[i]!));
  return { paths, model, n };
}

export async function editImages(
  apiKey: string,
  params: EditImageParams,
  opts?: { cwd?: string; baseUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<{ paths: string[]; model: string; n: number }> {
  const prompt = params.prompt?.trim();
  if (!prompt) throw new Error("prompt is required");
  const refs = (params.images ?? []).map((s) => s?.trim()).filter(Boolean) as string[];
  if (!refs.length) throw new Error("images requires at least one reference image");

  const n = clampN(params.n, MAX_IMAGE_N);
  const model = params.model?.trim() || XAI_IMAGINE_MODEL;
  const cwd = opts?.cwd ?? process.cwd();
  const outputPaths = expandOutputPaths(params.output_path, n, cwd, ".jpg", true);
  const urls = await Promise.all(refs.map((ref) => resolveXaiImageRef(ref, cwd)));

  const body: Record<string, unknown> = {
    model,
    prompt,
    n,
    resolution: "1k",
    response_format: "b64_json",
  };
  if (urls.length === 1) {
    body.image = { url: urls[0] };
  } else {
    body.images = urls.map((url) => ({ url }));
    body.aspect_ratio = params.aspect_ratio?.trim() || "auto";
  }

  const json = await postImagine(apiKey, "/images/edits", body, opts);
  const b64s = extractB64List(json, n);
  const paths = b64s.map((b64, i) => saveB64ToPath(b64, outputPaths[i]!));
  return { paths, model, n };
}

export function formatSavedPaths(kind: "generated" | "edited", paths: string[], model: string): string {
  const label = kind === "generated" ? "Saved image" : "Saved edited image";
  if (paths.length === 1) {
    return `${label}: ${paths[0]}\nmodel: ${model}`;
  }
  return `${label}s (${paths.length}):\n${paths.map((p) => `- ${p}`).join("\n")}\nmodel: ${model}`;
}
