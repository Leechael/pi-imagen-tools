import type { ImageProviderId } from "./constants.ts";

export function parseImageProvider(value: unknown): ImageProviderId {
  if (value === "xai" || value === "codex") return value;
  throw new Error(`provider must be "xai" or "codex", got ${String(value)}`);
}

/** Which backend a model id belongs to, if the name is unambiguous. */
export function imageModelFamily(model: string | undefined): ImageProviderId | undefined {
  const id = model?.trim() ?? "";
  if (!id) return undefined;
  if (id.startsWith("codex") || id.startsWith("gpt-image-")) return "codex";
  if (id.startsWith("grok-imagine")) return "xai";
  return undefined;
}

/**
 * Pick the image backend. Explicit provider wins only when it matches the
 * model family; a Codex model never rides on an xAI key (and vice versa).
 */
export function inferImageProvider(
  params: { provider?: string; model?: string },
  defaultProvider: ImageProviderId,
): ImageProviderId {
  const family = imageModelFamily(params.model);
  const provider = params.provider
    ? parseImageProvider(params.provider)
    : (family ?? defaultProvider);
  if (family && family !== provider) {
    throw new Error(
      `model ${JSON.stringify(params.model?.trim())} requires provider "${family}", not "${provider}"`,
    );
  }
  return provider;
}
