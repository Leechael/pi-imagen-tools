# Pi extension for image and video generation

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> **Image and video tools for Pi.** Generate and edit images through xAI Imagine or ChatGPT/Codex GPT Image 2, and generate short videos from one or more reference images through xAI.

This extension registers four tools and an interactive settings command. Credentials come from Pi's public provider auth API — no direct `auth.json` or third-party CLI state access.

## Why this exists

Pi is a small harness you adapt to your own workflow. Image and video generation usually means wiring multiple APIs, auth paths, and output conventions by hand. This extension packages that surface as Pi tools:

- **One tool surface for two image backends.** `image_gen` and `image_edit` can target xAI Imagine or ChatGPT/Codex GPT Image 2.
- **Video from stills via xAI.** `image_to_video` and `reference_to_video` cover single-image and multi-reference flows.
- **Pi-owned credentials.** Tools resolve keys through `ctx.modelRegistry.getApiKeyForProvider(...)`, including OAuth refresh written back by Pi.
- **Project and home defaults.** `/imagen-settings` edits provider, model, and Codex quality/size/background defaults.
- **No build step.** Pi loads the TypeScript extension directly.

## What this package adds

- **`image_gen`** — text-to-image via xAI or Codex.
- **`image_edit`** — edit from local paths, HTTPS URLs, data URIs, or recent conversation images.
- **`image_to_video`** — one source image to MP4 via xAI.
- **`reference_to_video`** — up to 7 reference images and/or up to 3 preset voices plus a prompt to MP4 via xAI.
- **xAI OAuth provider registration** — `pi.registerProvider("xai", ...)` for `/login xai`.
- **Codex via existing Pi auth** — uses the built-in `openai-codex` provider credentials.
- **`/imagen-settings`** — interactive TUI plus `status` / `reset` subcommands.
- **Sensible output path handling** — relative paths resolve to cwd; multi-`n` expands `{i}` or `-1`, `-2`, … suffixes.

## Install

Load a local checkout:

```bash
pi install /path/to/pi-imagen-tools
# or
pi -e /path/to/pi-imagen-tools
```

Or add the absolute path to Pi `settings.json` packages.

## Authentication

| Tool backend    | Pi provider id | How to authenticate                                                         |
| --------------- | -------------- | --------------------------------------------------------------------------- |
| `xai` (default) | `xai`          | `/login xai` (OAuth) or an API key stored for provider `xai`                |
| `codex`         | `openai-codex` | `/login openai-codex` (ChatGPT OAuth; needs account id in the access token) |

Every tool resolves credentials through Pi's public `getApiKeyForProvider` API. Pi owns credential precedence, persistence, refresh locking, and configured auth paths.

### API bases

- xAI media: `https://api.x.ai/v1`
  - images: `/images/generations`, `/images/edits`
  - video: `/videos/generations`
- Codex (official codex-rs image-generation surface): `https://chatgpt.com/backend-api/codex`
  - generate: `POST /images/generations`
  - edit: `POST /images/edits` with `images: [{ image_url }]` (max 5)
  - model always `gpt-image-2`; quality / size / background are separate fields

## Settings

Inside Pi:

```text
/imagen-settings          # interactive menu (TUI)
/imagen-settings status   # print resolved config
/imagen-settings reset    # delete home/project config files
```

Config files (env > project > home):

- Project: `<cwd>/.pi/pi-imagen-tools.json`
- Home: `~/.pi/pi-imagen-tools.json`

Fields:

| Field             | Default                      | Notes                                           |
| ----------------- | ---------------------------- | ----------------------------------------------- |
| `defaultProvider` | `xai`                        | `xai` or `codex` when the tool omits `provider` |
| `xaiModel`        | `grok-imagine-image-quality` | default xAI model for `image_gen`               |
| `codexModel`      | `codex-2`                    | alias only; API model stays `gpt-image-2`       |
| `codexQuality`    | `auto`                       | `auto` / `low` / `medium` / `high`              |
| `codexSize`       | `auto`                       | `auto` / `1K`/`2K`/`4K` / explicit `WxH`        |
| `codexBackground` | `auto`                       | `auto` / `opaque` / `transparent`               |

Environment overrides:

- `PI_IMAGEN_DEFAULT_PROVIDER`
- `PI_IMAGEN_XAI_MODEL`
- `PI_IMAGEN_CODEX_MODEL`
- `PI_IMAGEN_CODEX_QUALITY`
- `PI_IMAGEN_CODEX_SIZE`
- `PI_IMAGEN_CODEX_BACKGROUND`

### Example config

```json
{
  "defaultProvider": "xai",
  "xaiModel": "grok-imagine-image-quality",
  "codexModel": "codex-2",
  "codexQuality": "high",
  "codexSize": "auto",
  "codexBackground": "opaque"
}
```

## Tools

### `image_gen`

Generate image(s) from a text prompt.

| Param          | Required | Notes                                                                                 |
| -------------- | -------- | ------------------------------------------------------------------------------------- |
| `prompt`       | yes      |                                                                                       |
| `output_path`  | yes      | relative → cwd; normalized to `.jpg` (xAI) / `.png` (Codex)                           |
| `provider`     | no       | `xai` (default) or `codex`; inferred from `codex-*` / `gpt-image-2*` models           |
| `aspect_ratio` | no       | xAI ratios; Codex maps to fixed sizes                                                 |
| `size`         | no       | Codex: `auto` / `1K`/`2K`/`4K` / explicit `WxH` (≤3840px, 16px multiples, ratio ≤3:1) |
| `quality`      | no       | Codex: `auto` / `low` / `medium` / `high`                                             |
| `background`   | no       | Codex: `auto` / `opaque` / `transparent`                                              |
| `model`        | no       | xAI default `grok-imagine-image-quality`; Codex aliases mainly set quality            |
| `n`            | no       | default 1, max 10                                                                     |

### `image_edit`

Edit from reference images. Provide either `images` or `num_last_images_to_include`, not both empty.

| Param                             | Required    | Notes                                                                    |
| --------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `prompt`                          | yes         | complete desired output, including what must be preserved                |
| `images`                          | conditional | paths / https / data URI / current `[Image #N]`; **Codex max 5**         |
| `num_last_images_to_include`      | conditional | newest 1–5 conversation images                                           |
| `output_path`                     | yes         | same rules as gen                                                        |
| `provider`                        | no          | `xai` (default) or `codex`                                               |
| `aspect_ratio`                    | no          | xAI multi-ref; Codex size mapping                                        |
| `model`                           | no          | xAI override (default `grok-imagine-image-quality`); Codex from settings |
| `size` / `quality` / `background` | no          | Codex only                                                               |
| `n`                               | no          | default 1, max 10                                                        |

### `image_to_video` (xAI only)

| Param             | Required | Notes                     |
| ----------------- | -------- | ------------------------- |
| `image`           | yes      | path / https / data URI   |
| `output_path`     | yes      | `.mp4` default            |
| `prompt`          | no       | motion guidance           |
| `duration`        | no       | `6` (default) or `10`     |
| `resolution_name` | no       | `480p` (default) / `720p` |

### `reference_to_video` (xAI only)

| Param             | Required             | Notes                                                   |
| ----------------- | -------------------- | ------------------------------------------------------- |
| `prompt`          | yes                  | tag refs as `<IMAGE_0>`, `<AUDIO_0>`, …                 |
| `images`          | one of images/voices | up to 7 refs                                            |
| `voices`          | one of images/voices | up to 3 preset voices (`ara`, `eve`, `leo`, `rex`, …)   |
| `output_path`     | yes                  | `.mp4` default                                          |
| `aspect_ratio`    | yes                  | `1:1` / `16:9` / `9:16` / `4:3` / `3:4` / `3:2` / `2:3` |
| `duration`        | no                   | 1–15s, default `6`                                      |
| `resolution_name` | no                   | `480p` / `720p`                                         |

### Output path notes

For `n > 1` on image tools, `output_path` expands with `{i}` or `-1`, `-2`, … before the extension. Local reference MIME is detected from bytes rather than filename. Oversized xAI edit references are compressed toward grok-build's size limits.

## Development

Requirements: Node.js 22+.

```bash
npm install
npm test
npm run check
npm run lint
npm run format:check
```

Format and fix style:

```bash
npm run format
```

Pre-commit hooks (oxlint + oxfmt) via [prek](https://github.com/j178/prek):

```bash
npm run pre-commit
# or install git hooks:
npx prek install
```

## Troubleshooting

### Tool says missing credentials

Run the matching login:

```text
/login xai
/login openai-codex
```

Codex also needs an account id inside the access token. If login succeeded but tools still fail, re-run `/login openai-codex`.

### Codex edit rejects the request

Codex accepts at most 5 reference images. Prefer fewer, higher-signal refs. Confirm `provider` is `codex` only when you intend the ChatGPT backend.

### Output extension looks wrong

xAI image outputs normalize to `.jpg`; Codex normalizes to `.png`. Video tools default to `.mp4`. Pass a path without forcing a mismatched extension when unsure.

### Project config seems ignored

Project config is only read when the Pi context reports the project as trusted. Untrusted projects fall back to home + env. Run `/imagen-settings status` to see which sources applied.

## References

- Pi: [earendil-works/pi](https://github.com/earendil-works/pi)
- xAI API: [docs.x.ai](https://docs.x.ai/)

## License

MIT
