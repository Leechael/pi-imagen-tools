import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  clampVideoDuration,
  imageToVideo,
  referenceToVideo,
  resolveMp4OutputPath,
  resolveVideoResolution,
} from "../src/video.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("video", () => {
  it("clamps duration and resolution", () => {
    assert.equal(clampVideoDuration(undefined), 6);
    assert.equal(clampVideoDuration(10), 10);
    assert.throws(() => clampVideoDuration(8));
    assert.equal(resolveVideoResolution(), "480p");
    assert.equal(resolveVideoResolution("720p"), "720p");
    assert.throws(() => resolveVideoResolution("1080p"));
  });

  it("resolves output paths to the actual MP4 format", () => {
    assert.equal(resolveMp4OutputPath("clip", "/work"), "/work/clip.mp4");
    assert.equal(resolveMp4OutputPath("/abs/out.mp4", "/work"), "/abs/out.mp4");
    assert.equal(resolveMp4OutputPath("/abs/out.mov", "/work"), "/abs/out.mp4");
  });

  it("imageToVideo posts generations, polls, downloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-vid-"));
    dirs.push(dir);
    const src = join(dir, "in.jpg");
    writeFileSync(src, Buffer.from("ffd8ffe000104a464946", "hex"));
    const out = join(dir, "out.mp4");
    const calls: string[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/videos/generations")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        assert.equal(body.model, "grok-imagine-video-1.5-preview");
        assert.equal(body.duration, 6);
        assert.equal(body.resolution, "480p");
        assert.ok((body.image as { url: string }).url.startsWith("data:image/jpeg"));
        return new Response(JSON.stringify({ request_id: "req-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/videos/req-1")) {
        return new Response(
          JSON.stringify({
            status: "done",
            model: "grok-imagine-video-1.5-preview",
            video: { url: "https://cdn.example/v.mp4", duration: 6 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://cdn.example/v.mp4") {
        return new Response(Buffer.from("mp4-bytes"), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    };

    const result = await imageToVideo(
      "tok",
      { image: src, output_path: out, prompt: "pan left" },
      { fetchImpl, cwd: dir, pollIntervalMs: 1 },
    );

    assert.equal(result.path, out);
    assert.equal(result.requestId, "req-1");
    assert.equal(readFileSync(out).toString(), "mp4-bytes");
    assert.ok(calls.some((u) => u.endsWith("/videos/generations")));
    assert.ok(calls.some((u) => u.endsWith("/videos/req-1")));
  });

  it("times out a stalled video download", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-download-timeout-"));
    dirs.push(dir);
    const src = join(dir, "in.jpg");
    writeFileSync(src, Buffer.from("ffd8ffe000104a464946", "hex"));

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/videos/generations")) {
        return new Response(JSON.stringify({ request_id: "timeout-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/videos/timeout-1")) {
        return new Response(
          JSON.stringify({ status: "done", video: { url: "https://cdn.example/stalled.mp4" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    };

    await assert.rejects(
      () =>
        imageToVideo(
          "tok",
          { image: src, output_path: join(dir, "out.mp4") },
          { fetchImpl, cwd: dir, pollIntervalMs: 1, downloadTimeoutMs: 5 },
        ),
      /Video download timed out after 5ms/,
    );
  });

  it("referenceToVideo sends reference_images and base model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-r2v-"));
    dirs.push(dir);
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    writeFileSync(a, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    writeFileSync(b, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    const out = join(dir, "r.mp4");
    let genBody: Record<string, unknown> = {};

    let polled = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/videos/generations")) {
        genBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(JSON.stringify({ request_id: "r2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/videos/r2")) {
        if (!polled) {
          polled = true;
          return new Response(JSON.stringify({ status: "pending" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            status: "done",
            video: { url: "https://cdn.example/r.mp4", duration: 10 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://cdn.example/r.mp4") {
        return new Response(Buffer.from("vid"), { status: 200 });
      }
      throw new Error(url);
    };

    const result = await referenceToVideo(
      "tok",
      {
        prompt: "cinematic blend",
        images: [a, b],
        output_path: out,
        duration: 10,
        aspect_ratio: "16:9",
      },
      { fetchImpl, cwd: dir, pollIntervalMs: 1 },
    );

    assert.equal(result.requestId, "r2");
    assert.equal(genBody.model, "grok-imagine-video");
    assert.equal(genBody.duration, 10);
    assert.equal(genBody.aspect_ratio, "16:9");
    assert.equal(Array.isArray(genBody.reference_images), true);
    assert.equal((genBody.reference_images as unknown[]).length, 2);
    assert.equal(readFileSync(out).toString(), "vid");
  });

  it("rejects fewer than 2 refs", async () => {
    await assert.rejects(
      () =>
        referenceToVideo("t", {
          prompt: "x",
          images: ["only-one"],
          output_path: "/tmp/x.mp4",
          aspect_ratio: "16:9",
        }),
      /at least 2/,
    );
  });

  it("requires a supported aspect ratio for reference video", async () => {
    await assert.rejects(
      () =>
        referenceToVideo("t", {
          prompt: "x",
          images: ["a", "b"],
          output_path: "/tmp/x.mp4",
          aspect_ratio: "4:3",
        }),
      /aspect_ratio must be one of/,
    );
  });
});
