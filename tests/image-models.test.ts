import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImageModel } from "@earendil-works/pi-ai";
import { generateXaiImages, registerXaiImageModels, XAI_IMAGES_API } from "../src/image-models.ts";
import { XAI_IMAGINE_MODEL, XAI_PROVIDER_ID } from "../src/constants.ts";

const model = {
  type: "image",
  api: XAI_IMAGES_API,
  provider: XAI_PROVIDER_ID,
  id: XAI_IMAGINE_MODEL,
} as unknown as ImageModel<typeof XAI_IMAGES_API>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("generateXaiImages", () => {
  it("errors without an api key", async () => {
    const result = await generateXaiImages(model, { input: [{ type: "text", text: "hi" }] });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /No API key/);
    assert.deepEqual(result.output, []);
  });

  it("posts a generations request and returns image content", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(_input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({ data: [{ b64_json: "aGk=" }] });
    };
    const result = await generateXaiImages(
      model,
      { input: [{ type: "text", text: "a cat" }] },
      { apiKey: "key", fetch: fetchImpl },
    );
    assert.equal(result.stopReason, "stop");
    assert.equal(result.api, XAI_IMAGES_API);
    assert.equal(result.provider, XAI_PROVIDER_ID);
    assert.equal(result.model, XAI_IMAGINE_MODEL);
    assert.deepEqual(result.output, [{ type: "image", data: "aGk=", mimeType: "image/jpeg" }]);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/images\/generations$/);
    assert.equal(calls[0]!.body.model, XAI_IMAGINE_MODEL);
    assert.equal(calls[0]!.body.prompt, "a cat");
    assert.equal(calls[0]!.body.response_format, "b64_json");
  });

  it("routes reference images to the edits endpoint", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(_input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({ data: [{ b64_json: "aGk=" }] });
    };
    const result = await generateXaiImages(
      model,
      {
        input: [
          { type: "text", text: "make it red" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
      },
      { apiKey: "key", fetch: fetchImpl, aspectRatio: "16:9" },
    );
    assert.equal(result.stopReason, "stop");
    assert.match(calls[0]!.url, /\/images\/edits$/);
    assert.deepEqual(calls[0]!.body.images, [
      { url: "data:image/png;base64,iVBORw0KGgo=" },
      { url: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
    assert.equal(calls[0]!.body.aspect_ratio, "16:9");
  });

  it("reports errors without throwing", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    const result = await generateXaiImages(
      model,
      { input: [{ type: "text", text: "hi" }] },
      { apiKey: "key", fetch: fetchImpl },
    );
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /HTTP 500/);
  });

  it("reports aborted requests", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = async () => {
      throw new Error("Image request cancelled");
    };
    const result = await generateXaiImages(
      model,
      { input: [{ type: "text", text: "hi" }] },
      { apiKey: "key", fetch: fetchImpl, signal: controller.signal },
    );
    assert.equal(result.stopReason, "aborted");
  });
});

describe("registerXaiImageModels", () => {
  it("registers an image model plus its images implementation", () => {
    const registrations: unknown[] = [];
    const pi = {
      registerProvider(name: string, config: unknown) {
        registrations.push({ name, config });
      },
    };
    const oauth = {
      name: "xAI (Grok/X subscription)",
      login: async () => ({ access: "a", refresh: "r", expires: 1 }),
      refreshToken: async (c: { access: string; refresh: string; expires: number }) => c,
      getApiKey: (c: { access: string }) => c.access,
    };
    registerXaiImageModels(pi as never, oauth);
    assert.equal(registrations.length, 1);
    const { name, config } = registrations[0] as {
      name: string;
      config: {
        oauth: unknown;
        models: Array<Record<string, unknown>>;
        images: Record<string, { generateImages: unknown }>;
      };
    };
    assert.equal(name, XAI_PROVIDER_ID);
    assert.equal(config.oauth, oauth);
    assert.equal(config.models.length, 1);
    assert.equal(config.models[0]!.type, "image");
    assert.equal(config.models[0]!.id, XAI_IMAGINE_MODEL);
    assert.equal(config.models[0]!.api, XAI_IMAGES_API);
    assert.ok(config.images[XAI_IMAGES_API]?.generateImages);
  });
});
