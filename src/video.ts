import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import {
  IMAGE_GEN_TIMEOUT_MS,
  USER_AGENT,
  VIDEO_DOWNLOAD_TIMEOUT_MS,
  XAI_IMAGINE_BASE_URL,
  XAI_VIDEO_MODEL,
} from "./constants.ts";
import { resolveImagineImageRef } from "./imagine.ts";

export type ImageToVideoParams = {
  image: string;
  output_path: string;
  prompt?: string;
  duration?: number | string;
  resolution?: string;
  model?: string;
};

export type ReferenceToVideoParams = {
  prompt: string;
  images?: string[];
  voices?: string[];
  output_path: string;
  aspect_ratio: string;
  duration?: number | string;
  resolution?: string;
  model?: string;
};

export type VideoResult = {
  path: string;
  requestId: string;
  model: string;
  duration: number;
  resolution: string;
};

const VALID_RESOLUTIONS = new Set(["480p", "720p"]);
const VALID_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);

const MAX_R2V_REFERENCE_IMAGES = 7;
const MAX_R2V_REFERENCE_VOICES = 3;
const MIN_R2V_DURATION_SECS = 1;
const MAX_R2V_DURATION_SECS = 15;

/** grok-build image_to_video duration: exactly 6 or 10 seconds, default 6. */
export function clampVideoDuration(raw: unknown): 6 | 10 {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (n === 10) return 10;
  if (n === 6 || raw === undefined || raw === null || raw === "") return 6;
  throw new Error(`duration must be 6 or 10 seconds, got ${String(raw)}`);
}

/** grok-build reference_to_video duration: whole seconds 1–15, default 6. */
export function resolveR2vDuration(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 6;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (Number.isInteger(n) && n >= MIN_R2V_DURATION_SECS && n <= MAX_R2V_DURATION_SECS) return n;
  throw new Error(
    `duration must be between ${MIN_R2V_DURATION_SECS} and ${MAX_R2V_DURATION_SECS} seconds, got ${String(raw)}`,
  );
}

export function resolveVideoResolution(raw?: string): string {
  const value = (raw ?? "480p").trim() || "480p";
  if (!VALID_RESOLUTIONS.has(value)) {
    throw new Error(`resolution must be 480p or 720p, got ${value}`);
  }
  return value;
}

function videoHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
}

export function resolveMp4OutputPath(outputPath: string, cwd: string): string {
  const cleaned = outputPath.trim();
  if (!cleaned) throw new Error("output_path is required");
  const withExt = /\.mp4$/i.test(cleaned)
    ? cleaned
    : /\.(webm|mov)$/i.test(cleaned)
      ? cleaned.replace(/\.(webm|mov)$/i, ".mp4")
      : `${cleaned}.mp4`;
  return isAbsolute(withExt) ? withExt : resolvePath(cwd, withExt);
}

export async function startAndPollVideo(
  apiKey: string,
  body: Record<string, unknown>,
  opts?: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    pollIntervalMs?: number;
  },
): Promise<{ requestId: string; url: string; model?: string; duration?: number }> {
  const baseUrl = (opts?.baseUrl ?? XAI_IMAGINE_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? IMAGE_GEN_TIMEOUT_MS;
  const pollIntervalMs = opts?.pollIntervalMs ?? 2_500;
  const headers = videoHeaders(apiKey);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const start = await fetchImpl(`${baseUrl}/videos/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!start.ok) {
      const text = await start.text().catch(() => "");
      throw new Error(`Video start HTTP ${start.status}: ${text.slice(0, 400)}`);
    }
    const started = (await start.json()) as { request_id?: string };
    const requestId = started.request_id?.trim();
    if (!requestId) throw new Error("No request_id from video API");

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (controller.signal.aborted) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const res = await fetchImpl(`${baseUrl}/videos/${requestId}`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok && res.status !== 202) {
        const t = await res.text().catch(() => "");
        throw new Error(`Video status HTTP ${res.status}: ${t.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        status?: string;
        error?: string;
        model?: string;
        video?: { url?: string; duration?: number };
      };
      if (json.status === "done") {
        const url = json.video?.url?.trim();
        if (!url) throw new Error("Video done but no download URL");
        return {
          requestId,
          url,
          model: json.model,
          duration: json.video?.duration,
        };
      }
      if (json.status === "failed") throw new Error(json.error || "Video generation failed");
      if (json.status === "expired") throw new Error("Video request expired");
    }
    throw new Error(`Timed out waiting for video generation (${timeoutMs}ms)`);
  } catch (error) {
    if (controller.signal.aborted && opts?.signal?.aborted) {
      throw new Error("Video request cancelled");
    }
    if (controller.signal.aborted) {
      throw new Error(`Video request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}

async function downloadToPath(
  url: string,
  outputPath: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  timeoutMs = VIDEO_DOWNLOAD_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Video download failed HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, bytes);
    return outputPath;
  } catch (error) {
    if (controller.signal.aborted && signal?.aborted) {
      throw new Error("Video download cancelled");
    }
    if (controller.signal.aborted) {
      throw new Error(`Video download timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** grok-build image_to_video: single source image → video. */
export async function imageToVideo(
  apiKey: string,
  params: ImageToVideoParams,
  opts?: {
    cwd?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    pollIntervalMs?: number;
    downloadTimeoutMs?: number;
  },
): Promise<VideoResult> {
  const cwd = opts?.cwd ?? process.cwd();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const imageUrl = resolveImagineImageRef(params.image, cwd);
  const duration = clampVideoDuration(params.duration);
  const resolution = resolveVideoResolution(params.resolution);
  const model = params.model?.trim() || XAI_VIDEO_MODEL;
  const outputPath = resolveMp4OutputPath(params.output_path, cwd);

  const body: Record<string, unknown> = {
    model,
    duration,
    resolution,
    image: { url: imageUrl },
    prompt: params.prompt?.trim() ?? "",
  };

  const done = await startAndPollVideo(apiKey, body, {
    baseUrl: opts?.baseUrl,
    fetchImpl,
    signal: opts?.signal,
    pollIntervalMs: opts?.pollIntervalMs,
  });
  await downloadToPath(done.url, outputPath, fetchImpl, opts?.signal, opts?.downloadTimeoutMs);
  return {
    path: outputPath,
    requestId: done.requestId,
    model: done.model || model,
    duration: done.duration ?? duration,
    resolution,
  };
}

/** grok-build reference_to_video: up to 7 image refs and/or up to 3 preset voices + required prompt. */
export async function referenceToVideo(
  apiKey: string,
  params: ReferenceToVideoParams,
  opts?: {
    cwd?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    pollIntervalMs?: number;
    downloadTimeoutMs?: number;
  },
): Promise<VideoResult> {
  const cwd = opts?.cwd ?? process.cwd();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const prompt = params.prompt?.trim();
  if (!prompt) throw new Error("prompt is required");
  const refs = (params.images ?? []).map((s) => s?.trim()).filter(Boolean) as string[];
  const voices = (params.voices ?? []).map((s) => s?.trim()).filter(Boolean) as string[];
  if (refs.length === 0 && voices.length === 0) {
    throw new Error("provide at least one reference: images (up to 7) and/or voices (up to 3)");
  }
  if (refs.length > MAX_R2V_REFERENCE_IMAGES) {
    throw new Error(`images must contain at most ${MAX_R2V_REFERENCE_IMAGES} reference images`);
  }
  if (voices.length > MAX_R2V_REFERENCE_VOICES) {
    throw new Error(`voices must contain at most ${MAX_R2V_REFERENCE_VOICES} preset voices`);
  }

  const aspect = params.aspect_ratio?.trim();
  if (!aspect || !VALID_ASPECT_RATIOS.has(aspect)) {
    throw new Error(
      `aspect_ratio must be one of ${[...VALID_ASPECT_RATIOS].join(", ")}, got ${String(params.aspect_ratio)}`,
    );
  }
  const duration = resolveR2vDuration(params.duration);
  const resolution = resolveVideoResolution(params.resolution);
  const model = params.model?.trim() || XAI_VIDEO_MODEL;
  const outputPath = resolveMp4OutputPath(params.output_path, cwd);
  const reference_images = refs.map((r) => ({ url: resolveImagineImageRef(r, cwd) }));

  const body: Record<string, unknown> = {
    model,
    prompt,
    duration,
    resolution,
    reference_images,
    reference_audios: voices.map((voice_id) => ({ voice_id })),
    aspect_ratio: aspect,
  };

  const done = await startAndPollVideo(apiKey, body, {
    baseUrl: opts?.baseUrl,
    fetchImpl,
    signal: opts?.signal,
    pollIntervalMs: opts?.pollIntervalMs,
  });
  await downloadToPath(done.url, outputPath, fetchImpl, opts?.signal, opts?.downloadTimeoutMs);
  return {
    path: outputPath,
    requestId: done.requestId,
    model: done.model || model,
    duration: done.duration ?? duration,
    resolution,
  };
}

export function formatSavedVideo(result: VideoResult): string {
  return [
    `Saved video: ${result.path}`,
    `request: ${result.requestId}`,
    `model: ${result.model}`,
    `duration: ${result.duration}s`,
    `resolution: ${result.resolution}`,
  ].join("\n");
}
