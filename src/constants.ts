export const XAI_IMAGINE_MODEL = "grok-imagine-image-quality";
export const XAI_IMAGINE_BASE_URL = "https://api.x.ai/v1";
export const XAI_PROVIDER_ID = "xai";
/** grok-build default video model for image_to_video and reference_to_video */
export const XAI_VIDEO_MODEL = "grok-imagine-video-1.5";

/** Pi auth.json provider id for ChatGPT/Codex OAuth. */
export const CODEX_PROVIDER_ID = "openai-codex";
/** Official Codex images base (generations/edits under this prefix). */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Official image model used by codex-rs ext/image-generation. */
export const CODEX_IMAGE_MODEL = "gpt-image-2";
export const CODEX_DEFAULT_ALIAS = "codex-2";
/** Official tool allows at most 5 reference images. */
export const CODEX_MAX_EDIT_IMAGES = 5;

/** Client-side ceiling for `n`. */
export const MAX_IMAGE_N = 10;

export const IMAGE_GEN_TIMEOUT_MS = 300_000;
export const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

export const USER_AGENT = "pi-imagen-tools/0.1.0";
export const CODEX_ORIGINATOR = "pi-imagen-tools";

export type ImageProviderId = "xai" | "codex";
