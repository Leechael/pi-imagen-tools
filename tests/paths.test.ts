import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampN,
  ensureImageExtension,
  expandOutputPaths,
  resolveOutputPath,
} from "../src/paths.ts";

describe("paths", () => {
  it("adds or normalizes the extension to the actual output format", () => {
    assert.equal(ensureImageExtension("/tmp/out"), "/tmp/out.jpg");
    assert.equal(ensureImageExtension("/tmp/out.png"), "/tmp/out.png");
    assert.equal(ensureImageExtension("/tmp/out.jpg", ".png", true), "/tmp/out.png");
  });

  it("resolves relative output_path against cwd", () => {
    assert.equal(resolveOutputPath("shots/a", "/work"), "/work/shots/a.jpg");
  });

  it("expands n>1 with numeric suffix", () => {
    assert.deepEqual(expandOutputPaths("/tmp/out.jpg", 3, "/"), [
      "/tmp/out-1.jpg",
      "/tmp/out-2.jpg",
      "/tmp/out-3.jpg",
    ]);
  });

  it("expands n>1 with {i} placeholder", () => {
    assert.deepEqual(expandOutputPaths("/tmp/frame-{i}.png", 2, "/"), [
      "/tmp/frame-1.png",
      "/tmp/frame-2.png",
    ]);
  });

  it("clamps n defaults and rejects invalid", () => {
    assert.equal(clampN(undefined, 10), 1);
    assert.equal(clampN(4, 10), 4);
    assert.throws(() => clampN(0, 10));
    assert.throws(() => clampN(11, 10));
  });
});
