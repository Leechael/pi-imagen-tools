import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  describeCodexHttpError,
  editCodexImages,
  generateCodexImages,
  mapCodexSize,
  resolveCodexAlias,
  resolveCodexApiModel,
  resolveCodexBackground,
  resolveCodexQuality,
} from "../src/codex.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("codex helpers", () => {
  it("resolves aliases to quality tiers but API model stays gpt-image-2", () => {
    assert.equal(resolveCodexAlias("codex-2"), "gpt-image-2-medium");
    assert.equal(resolveCodexAlias("codex-2-high"), "gpt-image-2-high");
    assert.equal(resolveCodexApiModel("codex-2-high"), "gpt-image-2");
    assert.equal(resolveCodexQuality("gpt-image-2-low"), "low");
    assert.equal(resolveCodexQuality("gpt-image-2", "high"), "high");
    assert.equal(resolveCodexQuality("gpt-image-2"), "auto");
    assert.equal(resolveCodexBackground(undefined), "auto");
    assert.equal(resolveCodexBackground("transparent"), "transparent");
  });

  it("maps size/aspect; default auto when unspecified", () => {
    assert.equal(mapCodexSize().size, "auto");
    assert.equal(mapCodexSize("auto").size, "auto");
    assert.equal(mapCodexSize("1K", "16:9").size, "1536x1024");
    assert.equal(mapCodexSize("1K", "9:16").size, "1024x1536");
    assert.equal(mapCodexSize(undefined, "16:9").size, "1536x1024");
    assert.equal(mapCodexSize("512").size, "1024x1024");
    assert.ok(mapCodexSize("2K").warnings.length > 0);
  });

  it("generateCodexImages posts /images/generations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-codex-"));
    dirs.push(dir);
    const requestedOut = join(dir, "out.jpg");
    const out = join(dir, "out.png");
    const b64 = Buffer.from("fake-png").toString("base64");
    let captured: {
      url?: string;
      auth?: string;
      account?: string;
      body?: Record<string, unknown>;
    } = {};

    const fetchImpl: typeof fetch = async (input, init) => {
      captured = {
        url: String(input),
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
        account: new Headers(init?.headers).get("chatgpt-account-id") ?? undefined,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await generateCodexImages(
      { apiKey: "tok", accountId: "acc-1" },
      { prompt: "a cat", output_path: requestedOut, model: "codex-2", aspect_ratio: "16:9" },
      { fetchImpl, cwd: dir },
    );

    assert.equal(result.paths[0], out);
    assert.equal(readFileSync(out).toString(), "fake-png");
    assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/images/generations");
    assert.equal(captured.auth, "Bearer tok");
    assert.equal(captured.account, "acc-1");
    assert.equal(captured.body?.model, "gpt-image-2");
    assert.equal(captured.body?.prompt, "a cat");
    assert.equal(captured.body?.quality, "medium");
    assert.equal(captured.body?.size, "1536x1024");
    assert.equal(captured.body?.background, "auto");
  });

  it("editCodexImages posts /images/edits with image_url refs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-codex-edit-"));
    dirs.push(dir);
    const ref = join(dir, "ref.png");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    writeFileSync(ref, png);
    const out = join(dir, "edit.png");
    const b64 = Buffer.from("edited").toString("base64");
    let body: Record<string, unknown> = {};
    let url = "";

    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await editCodexImages(
      { apiKey: "tok", accountId: "acc-1" },
      { prompt: "make blue", images: [ref], output_path: out, quality: "auto" },
      { fetchImpl, cwd: dir },
    );

    assert.equal(result.paths[0], out);
    assert.equal(readFileSync(out).toString(), "edited");
    assert.equal(url, "https://chatgpt.com/backend-api/codex/images/edits");
    assert.equal(body.model, "gpt-image-2");
    assert.deepEqual(body.images, [
      { image_url: `data:image/png;base64,${png.toString("base64")}` },
    ]);
    assert.equal(body.quality, "auto");
  });

  it("rejects more than 5 reference images", async () => {
    await assert.rejects(
      () =>
        editCodexImages(
          { apiKey: "t", accountId: "a" },
          {
            prompt: "x",
            images: ["1", "2", "3", "4", "5", "6"],
            output_path: "/tmp/x.png",
          },
        ),
      /at most 5/,
    );
  });

  it("prefers response-echoed quality/size/background over request values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-codex-echo-"));
    dirs.push(dir);
    const out = join(dir, "echo.png");
    const b64 = Buffer.from("echo").toString("base64");

    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: b64 }],
          quality: "high",
          size: "1024x1536",
          background: "transparent",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await generateCodexImages(
      { apiKey: "tok", accountId: "acc-1" },
      { prompt: "a cat", output_path: out, model: "codex-2" },
      { fetchImpl, cwd: dir },
    );

    assert.equal(result.quality, "high");
    assert.equal(result.size, "1024x1536");
    assert.equal(result.background, "transparent");
  });

  it("falls back to request values when echo fields are missing or unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-codex-noecho-"));
    dirs.push(dir);
    const out = join(dir, "noecho.png");
    const b64 = Buffer.from("noecho").toString("base64");

    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: b64 }],
          quality: "ultra",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await generateCodexImages(
      { apiKey: "tok", accountId: "acc-1" },
      { prompt: "a cat", output_path: out, model: "codex-2" },
      { fetchImpl, cwd: dir },
    );

    assert.equal(result.quality, "medium");
    assert.equal(result.size, "auto");
    assert.equal(result.background, "auto");
  });

  it("describeCodexHttpError surfaces usage-limit details", () => {
    const body = JSON.stringify({
      error: { type: "usage_limit_reached", resets_at: 1778832973 },
    });
    const headers = new Headers({ "x-codex-active-limit": "image_gen" });
    const message = describeCodexHttpError(429, body, headers);
    assert.match(message, /usage limit reached/);
    assert.match(message, /limit: image_gen/);
    assert.match(message, /resets at 2026-05-15T/);
    assert.match(message, /Do not retry/);
  });

  it("describeCodexHttpError handles usage_not_included and error.message", () => {
    const noHeaders = new Headers();
    assert.match(
      describeCodexHttpError(
        429,
        JSON.stringify({ error: { type: "usage_not_included" } }),
        noHeaders,
      ),
      /not included in the current plan/,
    );
    assert.equal(
      describeCodexHttpError(400, JSON.stringify({ error: { message: "bad prompt" } }), noHeaders),
      "Codex Images API HTTP 400: bad prompt",
    );
    assert.equal(
      describeCodexHttpError(500, "<html>oops</html>", noHeaders),
      "Codex Images API HTTP 500: <html>oops</html>",
    );
  });
});
