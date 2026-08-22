import { Type } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createXaiOAuth, extractCodexAccountId } from "./src/auth.ts";
import { registerSettingsCommand } from "./src/command.ts";
import { isProjectTrustedContext, loadConfig, type ResolvedImagenConfig } from "./src/config.ts";
import { editCodexImages, generateCodexImages } from "./src/codex.ts";
import {
  CODEX_DEFAULT_ALIAS,
  CODEX_MAX_EDIT_IMAGES,
  CODEX_PROVIDER_ID,
  MAX_IMAGE_N,
  XAI_IMAGINE_MODEL,
  XAI_PROVIDER_ID,
  type ImageProviderId,
} from "./src/constants.ts";
import {
  editImages,
  formatSavedPaths,
  generateImages,
  recentConversationImageRefs,
  resolveRequestedImageRefs,
} from "./src/imagine.ts";
import { formatSavedVideo, imageToVideo, referenceToVideo } from "./src/video.ts";

function parseProvider(value: unknown, fallback: ImageProviderId): ImageProviderId {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "xai" || value === "codex") return value;
  throw new Error(`provider must be "xai" or "codex", got ${String(value)}`);
}

function inferProvider(
  params: { provider?: string; model?: string },
  defaults: ResolvedImagenConfig,
): ImageProviderId {
  if (params.provider) return parseProvider(params.provider, defaults.defaultProvider);
  const model = params.model?.trim() ?? "";
  if (model.startsWith("codex") || model.startsWith("gpt-image-2") || model === "gpt-image-2") {
    return "codex";
  }
  return defaults.defaultProvider;
}

async function requireProviderApiKey(
  ctx: ExtensionContext,
  provider: string,
  loginProvider = provider,
): Promise<string> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
  if (!apiKey) {
    throw new Error(`Missing ${provider} credentials. Run \`/login ${loginProvider}\`.`);
  }
  return apiKey;
}

async function requireXaiApiKey(ctx: ExtensionContext): Promise<string> {
  return requireProviderApiKey(ctx, XAI_PROVIDER_ID);
}

async function requireCodexCredential(ctx: ExtensionContext) {
  const apiKey = await requireProviderApiKey(ctx, CODEX_PROVIDER_ID);
  const accountId = extractCodexAccountId(apiKey);
  if (!accountId) {
    throw new Error(
      "OpenAI Codex account id missing from access token. Run `/login openai-codex`.",
    );
  }
  return { apiKey, accountId };
}

function formatCodexMeta(result: {
  quality: string;
  size: string;
  background: string;
  warnings: string[];
}): string {
  const warn = result.warnings.length > 0 ? `\nwarnings: ${result.warnings.join("; ")}` : "";
  return `provider: codex\nquality: ${result.quality}\nsize: ${result.size}\nbackground: ${result.background}${warn}`;
}

async function resolvedConfig(cwd: string, ctx: unknown): Promise<ResolvedImagenConfig> {
  return loadConfig(cwd, isProjectTrustedContext(ctx));
}

function resolveEditImages(
  images: string[] | undefined,
  numLastImages: number | undefined,
  ctx: { cwd: string; sessionManager: { getBranch(): unknown[] } },
): string[] {
  const explicit = images ?? [];
  if (explicit.length > 0 && numLastImages !== undefined) {
    throw new Error("provide only one of images or num_last_images_to_include");
  }
  if (numLastImages !== undefined) {
    return recentConversationImageRefs(ctx.sessionManager.getBranch(), numLastImages, ctx.cwd);
  }
  if (explicit.length === 0) {
    throw new Error("image_edit requires images or num_last_images_to_include");
  }
  return resolveRequestedImageRefs(explicit, ctx.sessionManager.getBranch(), ctx.cwd);
}

export default function piImagenTools(pi: ExtensionAPI): void {
  pi.registerProvider(XAI_PROVIDER_ID, { oauth: createXaiOAuth() });
  registerSettingsCommand(pi);

  pi.registerTool(
    defineTool({
      name: "image_gen",
      label: "image_gen",
      description:
        "Generate image(s) from a text description. provider=xai uses xAI Imagine; provider=codex uses ChatGPT/Codex GPT Image 2 via official /images/generations (Pi openai-codex auth). Defaults from /imagen-settings. Requires output_path.",
      parameters: Type.Object({
        prompt: Type.String({ description: "Text description of the image to generate." }),
        output_path: Type.String({
          description:
            "Filesystem path to write the image. Relative paths resolve against cwd. Missing extension defaults to .jpg (xai) or .png (codex). For n>1, use {i} or auto -1,-2 suffixes.",
        }),
        provider: Type.Optional(
          Type.String({
            description:
              'Backend: "xai" or "codex". Default from settings; inferred from codex-2* / gpt-image-2* models.',
          }),
        ),
        aspect_ratio: Type.Optional(
          Type.String({
            description:
              "Aspect ratio. xAI: auto/1:1/16:9/... Codex: maps to fixed sizes; omit with size for auto.",
          }),
        ),
        size: Type.Optional(
          Type.String({
            description:
              'Codex size: "auto", "1K"/"2K"/"4K", or 1024x1024 / 1536x1024 / 1024x1536. Default from settings.',
          }),
        ),
        quality: Type.Optional(
          Type.String({
            description:
              'Codex quality: "auto" | "low" | "medium" | "high". Default from settings / model alias.',
          }),
        ),
        background: Type.Optional(
          Type.String({
            description:
              'Codex background: "auto" | "opaque" | "transparent". Default from settings.',
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: `xAI default ${XAI_IMAGINE_MODEL}. Codex aliases: ${CODEX_DEFAULT_ALIAS}, codex-2-low, codex-2-high. Defaults from /imagen-settings.`,
          }),
        ),
        n: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_IMAGE_N,
            description: `Number of images (default 1, max ${MAX_IMAGE_N}).`,
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const defaults = await resolvedConfig(ctx.cwd, ctx);
          const provider = inferProvider(
            { provider: params.provider, model: params.model },
            defaults,
          );

          if (provider === "codex") {
            const credential = await requireCodexCredential(ctx);
            const result = await generateCodexImages(
              credential,
              {
                prompt: params.prompt,
                output_path: params.output_path,
                model: params.model ?? defaults.codexModel,
                quality: params.quality ?? defaults.codexQuality,
                aspect_ratio: params.aspect_ratio,
                size: params.size ?? defaults.codexSize,
                background: params.background ?? defaults.codexBackground,
                n: params.n,
              },
              { cwd: ctx.cwd, signal },
            );
            return {
              content: [
                {
                  type: "text",
                  text: `${formatSavedPaths("generated", result.paths, result.model)}\n${formatCodexMeta(result)}`,
                },
              ],
              details: { provider, ...result },
            };
          }

          const apiKey = await requireXaiApiKey(ctx);
          const result = await generateImages(
            apiKey,
            {
              prompt: params.prompt,
              output_path: params.output_path,
              aspect_ratio: params.aspect_ratio,
              model: params.model ?? defaults.xaiModel,
              n: params.n,
            },
            { cwd: ctx.cwd, signal },
          );
          return {
            content: [
              {
                type: "text",
                text: `${formatSavedPaths("generated", result.paths, result.model)}\nprovider: xai`,
              },
            ],
            details: { provider, ...result },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: message }],
            details: { error: message },
            isError: true,
          };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "image_edit",
      label: "image_edit",
      description:
        "Edit reference image(s). The prompt must describe the complete desired output and explicitly state which identity, composition, and details to preserve. provider=xai uses xAI Imagine; provider=codex uses official Codex /images/edits (gpt-image-2, max 5 refs). Use images for paths/URLs/current [Image #N] attachments, or num_last_images_to_include for recent conversation images. Requires output_path.",
      parameters: Type.Object({
        prompt: Type.String({
          description:
            "Complete description of the desired output, including what to change and what identity/composition/details must remain unchanged.",
        }),
        images: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            description:
              "Reference image(s), in semantic order: filesystem path, https URL, data:image URI, or current [Image #N] attachment. Codex max 5.",
          }),
        ),
        num_last_images_to_include: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: CODEX_MAX_EDIT_IMAGES,
            description:
              "Use the newest N images from conversation history when target images have no stable path. Do not combine with images.",
          }),
        ),
        output_path: Type.String({
          description:
            "Filesystem path to write the edited image. Relative paths resolve against cwd.",
        }),
        provider: Type.Optional(
          Type.String({
            description: 'Backend: "xai" or "codex". Default from settings.',
          }),
        ),
        aspect_ratio: Type.Optional(
          Type.String({
            description: "xAI: multi-ref only. Codex: maps size with size param.",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: `xAI model override (default ${XAI_IMAGINE_MODEL}, e.g. grok-imagine-image-v2). Codex: from settings.`,
          }),
        ),
        size: Type.Optional(
          Type.String({
            description: "Codex size. Default from settings.",
          }),
        ),
        quality: Type.Optional(
          Type.String({
            description: "Codex quality. Default from settings.",
          }),
        ),
        background: Type.Optional(
          Type.String({
            description: "Codex background. Default from settings.",
          }),
        ),
        n: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_IMAGE_N,
            description: `Number of edited images (default 1, max ${MAX_IMAGE_N}).`,
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const defaults = await resolvedConfig(ctx.cwd, ctx);
          const provider = inferProvider({ provider: params.provider }, defaults);

          const images = resolveEditImages(params.images, params.num_last_images_to_include, ctx);

          if (provider === "codex") {
            if (images.length > CODEX_MAX_EDIT_IMAGES) {
              throw new Error(
                `codex image_edit supports at most ${CODEX_MAX_EDIT_IMAGES} reference images`,
              );
            }
            const credential = await requireCodexCredential(ctx);
            const result = await editCodexImages(
              credential,
              {
                prompt: params.prompt,
                images,
                output_path: params.output_path,
                model: defaults.codexModel,
                quality: params.quality ?? defaults.codexQuality,
                aspect_ratio: params.aspect_ratio,
                size: params.size ?? defaults.codexSize,
                background: params.background ?? defaults.codexBackground,
                n: params.n,
              },
              { cwd: ctx.cwd, signal },
            );
            return {
              content: [
                {
                  type: "text",
                  text: `${formatSavedPaths("edited", result.paths, result.model)}\n${formatCodexMeta(result)}`,
                },
              ],
              details: { provider, ...result },
            };
          }

          const apiKey = await requireXaiApiKey(ctx);
          const result = await editImages(
            apiKey,
            {
              prompt: params.prompt,
              images,
              output_path: params.output_path,
              aspect_ratio: params.aspect_ratio,
              model: params.model ?? defaults.xaiModel,
              n: params.n,
            },
            { cwd: ctx.cwd, signal },
          );
          return {
            content: [
              {
                type: "text",
                text: `${formatSavedPaths("edited", result.paths, result.model)}\nprovider: xai`,
              },
            ],
            details: { provider, ...result },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: message }],
            details: { error: message },
            isError: true,
          };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "image_to_video",
      label: "image_to_video",
      description:
        "Generate a video from one source image via xAI Imagine (grok-build image_to_video). Requires image + output_path. Optional motion prompt; duration 6 or 10s; resolution 480p/720p. Uses Pi xai OAuth.",
      parameters: Type.Object({
        image: Type.String({
          description: "Source image: filesystem path, https URL, or data:image URI.",
        }),
        output_path: Type.String({
          description: "Filesystem path for the .mp4 (relative → cwd).",
        }),
        prompt: Type.Optional(
          Type.String({
            description: "Optional motion/camera guidance (1–2 sentences).",
          }),
        ),
        duration: Type.Optional(Type.Number({ description: "6 or 10 seconds. Default 6." })),
        resolution_name: Type.Optional(
          Type.Union([Type.Literal("480p"), Type.Literal("720p")], {
            description: '"480p" (default) or "720p".',
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const apiKey = await requireXaiApiKey(ctx);
          const result = await imageToVideo(
            apiKey,
            {
              image: params.image,
              output_path: params.output_path,
              prompt: params.prompt,
              duration: params.duration,
              resolution: params.resolution_name,
            },
            { cwd: ctx.cwd, signal },
          );
          return {
            content: [{ type: "text", text: `${formatSavedVideo(result)}\nprovider: xai` }],
            details: { provider: "xai", ...result },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: message }],
            details: { error: message },
            isError: true,
          };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "reference_to_video",
      label: "reference_to_video",
      description:
        "Generate a video from reference images and/or preset voices + prompt via xAI Imagine (grok-build reference_to_video). Requires prompt, output_path, and at least one of images/voices. Tag refs in the prompt as <IMAGE_0>, <IMAGE_1>, ... and <AUDIO_0>, <AUDIO_1>, ... Duration 1–15s; resolution 480p/720p. Uses Pi xai OAuth.",
      parameters: Type.Object({
        prompt: Type.String({
          description:
            "Describe the desired video. Reference images as <IMAGE_0>, <IMAGE_1>, ... and voices as <AUDIO_0>, <AUDIO_1>, ...",
        }),
        images: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            maxItems: 7,
            description:
              "Up to 7 reference images (path / https / data URI): people, objects, clothing, settings.",
          }),
        ),
        voices: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            maxItems: 3,
            description:
              'Up to 3 preset voice identifiers the subject(s) speak in (e.g. "ara", "eve", "leo", "rex"; same roster as the xAI TTS API). Usable alongside images or on their own.',
          }),
        ),
        output_path: Type.String({
          description: "Filesystem path for the .mp4 (relative → cwd).",
        }),
        aspect_ratio: Type.Union(
          [
            Type.Literal("1:1"),
            Type.Literal("16:9"),
            Type.Literal("9:16"),
            Type.Literal("4:3"),
            Type.Literal("3:4"),
            Type.Literal("3:2"),
            Type.Literal("2:3"),
          ],
          { description: "Required output aspect ratio." },
        ),
        duration: Type.Optional(
          Type.Number({ description: "Duration in seconds, 1–15. Default 6." }),
        ),
        resolution_name: Type.Optional(
          Type.Union([Type.Literal("480p"), Type.Literal("720p")], {
            description: '"480p" (default) or "720p".',
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const apiKey = await requireXaiApiKey(ctx);
          const result = await referenceToVideo(
            apiKey,
            {
              prompt: params.prompt,
              images: params.images,
              voices: params.voices,
              output_path: params.output_path,
              aspect_ratio: params.aspect_ratio,
              duration: params.duration,
              resolution: params.resolution_name,
            },
            { cwd: ctx.cwd, signal },
          );
          return {
            content: [{ type: "text", text: `${formatSavedVideo(result)}\nprovider: xai` }],
            details: { provider: "xai", ...result },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: message }],
            details: { error: message },
            isError: true,
          };
        }
      },
    }),
  );
}
