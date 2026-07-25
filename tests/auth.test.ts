import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
    assert.equal(typeof (providers[0]?.config.oauth as { refreshToken?: unknown })?.refreshToken, "function");

    const providersRead: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "pi-imagen-auth-"));
    const output = join(dir, "result.jpg");
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("image").toString("base64") }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      await tools.get("image_gen")!.execute(
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
});
