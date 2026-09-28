import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferImageProvider, parseImageProvider } from "../src/provider.ts";

describe("inferImageProvider", () => {
  it("uses default when provider and model are omitted", () => {
    assert.equal(inferImageProvider({}, "xai"), "xai");
    assert.equal(inferImageProvider({}, "codex"), "codex");
  });

  it("routes gpt-image / codex models to Codex even when default is xai", () => {
    assert.equal(inferImageProvider({ model: "gpt-image-2" }, "xai"), "codex");
    assert.equal(inferImageProvider({ model: "gpt-image-2.5-flare" }, "xai"), "codex");
    assert.equal(inferImageProvider({ model: "codex-2" }, "xai"), "codex");
  });

  it("routes grok-imagine models to xAI even when default is Codex", () => {
    assert.equal(inferImageProvider({ model: "grok-imagine-image-quality" }, "codex"), "xai");
    assert.equal(inferImageProvider({ model: "grok-imagine-image-2.0" }, "codex"), "xai");
  });

  it("rejects a model from the other backend", () => {
    assert.throws(
      () => inferImageProvider({ provider: "xai", model: "gpt-image-2" }, "xai"),
      /requires provider "codex", not "xai"/,
    );
    assert.throws(
      () => inferImageProvider({ provider: "codex", model: "grok-imagine-image-quality" }, "codex"),
      /requires provider "xai", not "codex"/,
    );
  });

  it("keeps an explicit provider when the model is unknown", () => {
    assert.equal(inferImageProvider({ provider: "codex", model: "mystery" }, "xai"), "codex");
    assert.equal(inferImageProvider({ provider: "xai" }, "codex"), "xai");
  });

  it("rejects an invalid provider id", () => {
    assert.throws(() => parseImageProvider("openai"), /provider must be "xai" or "codex"/);
  });
});
