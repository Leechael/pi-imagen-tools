import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, it } from "node:test";
import {
  editImages,
  formatSavedPaths,
  generateImages,
  recentConversationImageRefs,
  resolveImagineImageRef,
  resolveRequestedImageRefs,
  resolveXaiImageRef,
} from "../src/imagine.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-imagen-"));
  dirs.push(dir);
  return dir;
}

describe("imagine", () => {
  it("resolveImagineImageRef detects image MIME from bytes, not the filename", () => {
    const dir = tempDir();
    const file = join(dir, "ref.jpg");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    writeFileSync(file, png);
    const uri = resolveImagineImageRef(file, dir);
    assert.equal(uri, `data:image/png;base64,${png.toString("base64")}`);
  });

  it("compresses oversized xAI references to the original Imagine limits", async () => {
    const dir = tempDir();
    const file = join(dir, "large.png");
    const raw = randomBytes(1000 * 1000 * 3);
    await sharp(raw, { raw: { width: 1000, height: 1000, channels: 3 } }).png().toFile(file);

    const uri = await resolveXaiImageRef(file, dir);
    const encoded = uri.slice(uri.indexOf(",") + 1);
    const compressed = Buffer.from(encoded, "base64");
    const metadata = await sharp(compressed).metadata();

    assert.match(uri, /^data:image\/jpeg;base64,/);
    assert.ok(compressed.length <= 400 * 1024);
    assert.ok((metadata.width ?? 0) <= 768);
    assert.ok((metadata.height ?? 0) <= 768);
  });

  it("resolves current attachment tokens and recent generated images from session history", () => {
    const dir = tempDir();
    const generated = join(dir, "generated.jpg");
    writeFileSync(generated, Buffer.from("ffd8ffe000104a464946", "hex"));
    const userImage = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const entries = [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "image_gen",
          content: [{ type: "text", text: `Saved image: ${generated}\nmodel: x` }],
          details: { paths: [generated] },
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "image", data: userImage, mimeType: "image/png" }],
        },
      },
    ];

    assert.deepEqual(resolveRequestedImageRefs(["[Image #1]"], entries, dir), [
      `data:image/png;base64,${userImage}`,
    ]);
    assert.deepEqual(recentConversationImageRefs(entries, 2, dir), [
      generated,
      `data:image/png;base64,${userImage}`,
    ]);
  });

  it("generateImages posts generations payload and writes files", async () => {
    const dir = tempDir();
    const out = join(dir, "gen.jpg");
    const b64 = Buffer.from("fake-image").toString("base64");
    let captured: { url?: string; body?: Record<string, unknown>; auth?: string } = {};

    const fetchImpl: typeof fetch = async (input, init) => {
      captured = {
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
      };
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await generateImages(
      "token",
      { prompt: "a cat", output_path: out, aspect_ratio: "1:1", n: 1 },
      { fetchImpl, cwd: dir },
    );

    assert.equal(result.paths[0], out);
    assert.equal(readFileSync(out).toString(), "fake-image");
    assert.equal(captured.url, "https://api.x.ai/v1/images/generations");
    assert.equal(captured.auth, "Bearer token");
    assert.equal(captured.body?.prompt, "a cat");
    assert.equal(captured.body?.n, 1);
    assert.equal(captured.body?.response_format, "b64_json");
  });

  it("editImages sends single image url object", async () => {
    const dir = tempDir();
    const ref = join(dir, "in.png");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    writeFileSync(ref, png);
    const out = join(dir, "edit.jpg");
    const b64 = Buffer.from("edited").toString("base64");
    let body: Record<string, unknown> = {};

    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await editImages(
      "token",
      { prompt: "make blue", images: [ref], output_path: out },
      { fetchImpl, cwd: dir },
    );

    assert.equal(result.paths[0], out);
    assert.equal(readFileSync(out).toString(), "edited");
    assert.deepEqual(body.image, {
      url: `data:image/png;base64,${png.toString("base64")}`,
    });
    assert.equal(body.aspect_ratio, undefined);
  });

  it("formatSavedPaths lists multiple paths", () => {
    const text = formatSavedPaths("generated", ["/a.jpg", "/b.jpg"], "m");
    assert.match(text, /Saved images \(2\)/);
    assert.match(text, /- \/a\.jpg/);
    assert.match(text, /model: m/);
  });
});
