import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import piImagenTools from "../index.ts";
import { createXaiOAuth, decodeJwtPayload, extractCodexAccountId } from "../src/auth.ts";

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `h.${encoded}.s`;
}

describe("auth helpers", () => {
  it("decodes JWT payloads", () => {
    assert.equal(decodeJwtPayload(jwt({ exp: 1_700_000_000 }))?.exp, 1_700_000_000);
    assert.equal(decodeJwtPayload("bad"), null);
  });

  it("extracts the Codex account id", () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
    });
    assert.equal(extractCodexAccountId(token), "acct_1");
  });

  it("refreshes xAI OAuth credentials through the registered provider", async () => {
    let requestBody = "";
    const oauth = createXaiOAuth(async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const credentials = await oauth.refreshToken({
      access: "old-access",
      refresh: "old-refresh",
      expires: 0,
    });

    assert.match(requestBody, /grant_type=refresh_token/);
    assert.match(requestBody, /refresh_token=old-refresh/);
    assert.equal(credentials.access, "new-access");
    assert.equal(credentials.refresh, "new-refresh");
  });

  it("passes the abort signal to the refresh request", async () => {
    const oauth = createXaiOAuth(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const pending = oauth.refreshToken(
      { access: "old-access", refresh: "old-refresh", expires: 0 },
      controller.signal,
    );
    controller.abort();
    await assert.rejects(pending, /aborted by signal/);
  });

  it("registers xAI OAuth and resolves tool auth through the public ModelRegistry API", async () => {
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    const providers: Array<{ name: string; config: Record<string, unknown> }> = [];
    piImagenTools({
      registerProvider(name: string, config: Record<string, unknown>) {
        providers.push({ name, config });
      },
      registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
    } as never);

    assert.equal(providers[0]?.name, "xai");
    assert.equal(
      typeof (providers[0]?.config.oauth as { refreshToken?: unknown })?.refreshToken,
      "function",
    );

    const providersRead: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-auth-"));
    const output = join(dir, "result.jpg");
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    try {
      await tools
        .get("image_gen")!
        .execute(
          "call-1",
          { prompt: "test", provider: "xai", output_path: output },
          undefined,
          undefined,
          {
            cwd: dir,
            modelRegistry: {
              async getApiKeyForProvider(provider: string) {
                providersRead.push(provider);
                return "xai-access";
              },
            },
          },
        );
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.deepEqual(providersRead, ["xai"]);
    assert.equal(readFileSync(output, "utf8"), "image");
  });

  it("image_edit with a gpt-image model uses openai-codex, not xai", async () => {
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    piImagenTools({
      registerProvider() {},
      registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
    } as never);

    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-edit-route-"));
    const ref = join(dir, "ref.png");
    writeFileSync(ref, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    const output = join(dir, "edit.png");
    const providersRead: string[] = [];
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: Buffer.from("edited").toString("base64") }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" },
    });
    try {
      const result = (await tools.get("image_edit")!.execute(
        "call-2",
        {
          prompt: "make blue",
          images: [ref],
          output_path: output,
          model: "gpt-image-2.5-flare",
        },
        undefined,
        undefined,
        {
          cwd: dir,
          sessionManager: { getBranch: () => [] },
          modelRegistry: {
            async getApiKeyForProvider(provider: string) {
              providersRead.push(provider);
              return token;
            },
          },
        },
      )) as { isError?: boolean };
      assert.equal(result.isError, undefined);
    } finally {
      globalThis.fetch = previousFetch;
    }

    assert.deepEqual(providersRead, ["openai-codex"]);
    assert.equal(urls[0], "https://chatgpt.com/backend-api/codex/images/edits");
    assert.equal(bodies[0]?.model, "gpt-image-2.5-flare");
    assert.equal(readFileSync(output, "utf8"), "edited");
  });

  it("refuses to send a Codex model with an xAI key", async () => {
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    piImagenTools({
      registerProvider() {},
      registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
    } as never);

    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-mismatch-"));
    const providersRead: string[] = [];
    const result = (await tools.get("image_gen")!.execute(
      "call-3",
      {
        prompt: "test",
        provider: "xai",
        model: "gpt-image-2",
        output_path: join(dir, "out.png"),
      },
      undefined,
      undefined,
      {
        cwd: dir,
        modelRegistry: {
          async getApiKeyForProvider(provider: string) {
            providersRead.push(provider);
            return "should-not-be-used";
          },
        },
      },
    )) as { isError?: boolean; details?: { error?: string } };

    assert.equal(result.isError, true);
    assert.match(result.details?.error ?? "", /requires provider "codex", not "xai"/);
    assert.deepEqual(providersRead, []);
  });
});
