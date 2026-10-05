import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piImagenTools from "../index.ts";

type CapturedTool = {
  name?: string;
  annotations?: Record<string, unknown>;
  outputSchema?: { properties?: Record<string, unknown>; required?: string[] };
};

function captureTools(): {
  tools: CapturedTool[];
  providers: Array<{ name: string; config: Record<string, unknown> }>;
  pi: ExtensionAPI;
} {
  const tools: CapturedTool[] = [];
  const providers: Array<{ name: string; config: Record<string, unknown> }> = [];
  const pi = {
    registerProvider(name: string, config: Record<string, unknown>) {
      providers.push({ name, config });
    },
    registerCommand() {},
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  piImagenTools(pi);
  return { tools, providers, pi };
}

describe("extension tool registration", () => {
  it("registers the four imagen tools", () => {
    const { tools } = captureTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["image_gen", "image_edit", "image_to_video", "reference_to_video"],
    );
  });

  it("marks tools as external-world, not read-only", () => {
    const { tools } = captureTools();
    for (const tool of tools) {
      assert.deepEqual(tool.annotations, { readOnlyHint: false, openWorldHint: true });
    }
  });

  it("registers the xai provider without replacing its model catalog", () => {
    const { providers } = captureTools();
    const xai = providers.find((provider) => provider.name === "xai");
    assert.ok(xai, "xai provider registration missing");
    assert.equal(typeof xai.config.oauth, "object");
    // pi's registerProvider replaces ALL models of a provider when `models` is given.
    // The built-in xai provider carries the grok chat models, so supplying `models`
    // here would wipe them from the model picker. Never do that without re-declaring
    // the built-in chat models.
    assert.equal(xai.config.models, undefined);
    assert.equal(xai.config.images, undefined);
  });

  it("declares output schemas for machine-readable success results", () => {
    const { tools } = captureTools();
    const imageTools = tools.filter(
      (tool) => tool.name === "image_gen" || tool.name === "image_edit",
    );
    const videoTools = tools.filter((tool) => tool.name?.includes("to_video"));
    for (const tool of imageTools) {
      assert.ok(tool.outputSchema, `${tool.name} missing outputSchema`);
      assert.deepEqual(tool.outputSchema?.required, ["provider", "model", "paths", "n"]);
    }
    for (const tool of videoTools) {
      assert.ok(tool.outputSchema, `${tool.name} missing outputSchema`);
      assert.deepEqual(tool.outputSchema?.required, [
        "provider",
        "model",
        "path",
        "requestId",
        "duration",
        "resolution",
      ]);
    }
  });
});
