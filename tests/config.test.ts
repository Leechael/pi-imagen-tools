import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_PROVIDER,
  formatStatus,
  loadConfig,
  saveConfig,
  validateConfig,
} from "../src/config.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.PI_IMAGEN_DEFAULT_PROVIDER;
  delete process.env.PI_IMAGEN_CODEX_QUALITY;
});

describe("config", () => {
  it("loads defaults when no files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-cfg-"));
    dirs.push(dir);
    const resolved = await loadConfig(dir, true);
    assert.equal(resolved.defaultProvider, DEFAULT_PROVIDER);
    assert.equal(resolved.codexQuality, "auto");
    assert.equal(resolved.codexApiModel, "gpt-image-2");
  });

  it("saves project config and merges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-cfg-"));
    dirs.push(dir);
    const path = await saveConfig("project", dir, {
      defaultProvider: "codex",
      codexQuality: "high",
    });
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(written.defaultProvider, "codex");
    assert.equal(written.codexQuality, "high");

    const resolved = await loadConfig(dir, true);
    assert.equal(resolved.defaultProvider, "codex");
    assert.equal(resolved.codexQuality, "high");
    assert.ok(resolved.sources.project);
  });

  it("env overrides file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-cfg-"));
    dirs.push(dir);
    await saveConfig("project", dir, { defaultProvider: "xai", codexQuality: "low" });
    process.env.PI_IMAGEN_DEFAULT_PROVIDER = "codex";
    process.env.PI_IMAGEN_CODEX_QUALITY = "medium";
    const resolved = await loadConfig(dir, true);
    assert.equal(resolved.defaultProvider, "codex");
    assert.equal(resolved.codexQuality, "medium");
  });

  it("derives codexApiModel from the configured codex model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-cfg-"));
    dirs.push(dir);
    await saveConfig("project", dir, { codexModel: "codex-2.5-sunburst" });
    const resolved = await loadConfig(dir, true);
    assert.equal(resolved.codexApiModel, "gpt-image-2.5-sunburst");
  });

  it("validate rejects bad provider", () => {
    assert.throws(() => validateConfig({ defaultProvider: "nope" as "xai" }, "t"));
  });

  it("formatStatus includes keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-cfg-"));
    dirs.push(dir);
    const resolved = await loadConfig(dir, true);
    const text = formatStatus(resolved, dir);
    assert.match(text, /defaultProvider/);
    assert.match(text, /codexQuality/);
  });
});
