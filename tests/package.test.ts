import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HOST_PROVIDED_EXTENSION_PACKAGES = new Set([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
  "@sinclair/typebox",
  "typebox",
]);

const manifest = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe("package.json host-provided packages", () => {
  it("does not list host-provided packages in dependencies", () => {
    const hostDependencies = Object.keys(manifest.dependencies ?? {})
      .filter((name) => HOST_PROVIDED_EXTENSION_PACKAGES.has(name))
      .sort();
    assert.deepEqual(hostDependencies, []);
  });

  it('declares typebox as a peerDependency with a "*" range', () => {
    assert.equal(manifest.peerDependencies?.typebox, "*");
  });
});
