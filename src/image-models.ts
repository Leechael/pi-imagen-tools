import type {
  AssistantImages,
  ImageApi,
  ImageContent,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { XAI_IMAGINE_MODEL, XAI_PROVIDER_ID } from "./constants.ts";
import { postImagine, resolveXaiImageRef, type ImagineResponse } from "./imagine.ts";

/**
 * Image API id for the xAI Imagine backend. Custom (non-builtin) ids are
 * allowed; the implementation is supplied in the provider's `images` record.
 */
export const XAI_IMAGES_API = "xai-imagine" as ImageApi;

export type XaiImagesModelConfig = {
  id: string;
  name: string;
};

/** OAuth login shape accepted by ExtensionAPI.registerProvider(). */
export interface XaiOAuthLogin {
  name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
}

/**
 * xAI Imagine as a pi image model. Registering it puts Grok Imagine in the
 * catalog (`getModelsOfType("image", "xai")`) so runtime-resolved auth and
 * future `generateImages()` callers (codemode `models.*`) work against the
 * same `/login xai` credential as the tools.
 *
 * Cost is reported as zero: Imagine is billed through the xAI subscription /
 * API credit balance, not per-token rates.
 */
export function registerXaiImageModels(
  pi: ExtensionAPI,
  oauth: XaiOAuthLogin,
  config?: XaiImagesModelConfig,
): void {
  const id = config?.id ?? XAI_IMAGINE_MODEL;
  pi.registerProvider(XAI_PROVIDER_ID, {
    oauth,
    models: [
      {
        type: "image",
        id,
        name: config?.name ?? "Grok Imagine (xAI)",
        api: XAI_IMAGES_API,
        input: ["text", "image"],
        output: ["image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    images: {
      [XAI_IMAGES_API]: { generateImages: generateXaiImages },
    },
  });
}

type XaiImagesCallOptions = ImagesOptions & {
  /** Aspect ratio for multi-reference edits, e.g. "16:9". */
  aspectRatio?: string;
  /** Imagine resolution label, e.g. "1k" (default) or "2k". */
  resolution?: string;
};

function textPrompt(context: ImagesContext): string {
  const text = context.input
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("xai-imagine requires a text prompt");
  return text;
}

async function imageRefs(context: ImagesContext): Promise<string[]> {
  const parts = context.input.filter((part): part is ImageContent => part.type === "image");
  return Promise.all(
    parts.map(async (part) => {
      if (typeof part.data !== "string" || part.data.length === 0) {
        throw new Error("xai-imagine image input must carry base64 data");
      }
      // Reuse the tool pipeline: validate, detect the mime, and compress to the 400KB ref limit.
      return resolveXaiImageRef(`data:${part.mimeType};base64,${part.data}`);
    }),
  );
}

function extractImages(json: ImagineResponse): string[] {
  const b64s = (json.data ?? [])
    .map((item) => item.b64_json)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (b64s.length === 0) throw new Error("Imagine API returned no b64_json data");
  return b64s;
}

export async function generateXaiImages(
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options?: XaiImagesCallOptions,
): Promise<AssistantImages> {
  const result: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };

  const apiKey = options?.apiKey;
  if (!apiKey) {
    result.stopReason = "error";
    result.errorMessage = `No API key for provider: ${model.provider}`;
    return result;
  }

  try {
    const prompt = textPrompt(context);
    const refs = await imageRefs(context);
    const body: Record<string, unknown> = {
      model: model.id,
      prompt,
      n: 1,
      response_format: "b64_json",
    };
    let path: string;
    if (refs.length === 0) {
      path = "/images/generations";
      body.aspect_ratio = "auto";
      body.resolution = options?.resolution ?? "1k";
    } else {
      path = "/images/edits";
      body.resolution = options?.resolution ?? "1k";
      if (refs.length === 1) {
        body.image = { url: await resolveXaiImageRef(refs[0]!) };
      } else {
        body.images = await Promise.all(
          refs.map(async (ref) => ({ url: await resolveXaiImageRef(ref) })),
        );
        body.aspect_ratio = options?.aspectRatio ?? "auto";
      }
    }

    const json = await postImagine(apiKey, path, body, {
      fetchImpl: options?.fetch,
      signal: options?.signal,
    });
    result.output = extractImages(json).map(
      (b64): ImageContent => ({ type: "image", data: b64, mimeType: "image/jpeg" }),
    );
    return result;
  } catch (error) {
    if (options?.signal?.aborted) {
      result.stopReason = "aborted";
      result.errorMessage = "xai-imagine request aborted";
    } else {
      result.stopReason = "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
    }
    return result;
  }
}
