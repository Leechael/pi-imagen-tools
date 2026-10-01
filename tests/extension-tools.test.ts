import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piImagenTools from "../index.ts";

type CapturedTool = {
  name?: string;
  annotations?: Record<string, unknown>;
  outputSchema?: { properties?: Record<string, unknown>; required?: string[] };
};

function captureTools(): { tools: CapturedTool[]; pi: ExtensionAPI } {
  const tools: CapturedTool[] = [];
  const pi = {
    registerProvider() {},
    registerCommand() {},
    registerTool(tool: CapturedTool) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  piImagenTools(pi);
  return { tools, pi };
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
