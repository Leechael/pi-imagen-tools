#!/usr/bin/env node
import fs from "node:fs";
/**
 * 还原 codex web_search API 功能点的 JS 脚本
 *
 * 调用 codex 后端 Responses API（非 api.openai.com），在 tools 中注入 web_search 工具，
 * 处理 SSE 流式响应，提取 web_search_call 事件和带 url_citation 的回复。
 *
 * 用法：
 *   export ACCESS_TOKEN="<你的 access token>"
 *   node web_search.js --list-models          # 列出可用模型
 *   node web_search.js "什么是 ClickHouse？"  # 带 web_search 的对话
 */

function loadPiAuth() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    const raw = fs.readFileSync(`${home}/.pi/agent/auth.json`, "utf8");
    const auth = JSON.parse(raw)["openai-codex"];
    if (!auth || !auth.access) return null;
    if (auth.expires && auth.expires < Date.now()) {
      console.error("⚠️  openai-codex token 已过期，请先刷新登录");
      process.exit(1);
    }
    return auth;
  } catch {
    return null;
  }
}

function getAccessToken() {
  const token = process.env.ACCESS_TOKEN;
  if (token) return { token, storedAccountId: "" };
  const auth = loadPiAuth();
  if (auth) return { token: auth.access, storedAccountId: auth.accountId || "" };
  console.error("❌ 错误：未找到 Access Token。");
  console.error(
    '     export ACCESS_TOKEN="<你的 access token>"，或确保 ~/.pi/agent/auth.json 含 openai-codex.access',
  );
  process.exit(1);
}

// codex OAuth token 是 JWT，payload 里带 chatgpt_account_id；
// 优先从 token 本身取，避免 env token 误配 auth.json 里别的账号 ID
function accountIdFromToken(token) {
  try {
    const payload = token.split(".")[1];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.chatgpt_account_id || "";
  } catch {
    return "";
  }
}

const { token: ACCESS_TOKEN, storedAccountId } = getAccessToken();
const BASE_URL = process.env.BASE_URL || "https://chatgpt.com/backend-api/codex";
const ACCOUNT_ID = process.env.ACCOUNT_ID || accountIdFromToken(ACCESS_TOKEN) || storedAccountId;
const CLIENT_VERSION = process.env.CLIENT_VERSION || "1.0.0";
const OVERRIDE_MODEL = process.env.OPENAI_MODEL || "";
const WEB_SEARCH_MODE = process.env.WEB_SEARCH_MODE || "live"; // "live" | "cached"
const SEARCH_CONTEXT_SIZE = process.env.SEARCH_CONTEXT_SIZE || "medium"; // "low" | "medium" | "high"

const args = process.argv.slice(2);
const LIST_MODELS_ONLY = args.includes("--list-models");
const imageProbeIdx = args.indexOf("--image-probe");
if (imageProbeIdx >= 0 && (!args[imageProbeIdx + 1] || args[imageProbeIdx + 1].startsWith("--"))) {
  console.error("❌ 用法: node web_search.js --image-probe <model>");
  process.exit(1);
}
const IMAGE_PROBE_MODEL = imageProbeIdx >= 0 ? args[imageProbeIdx + 1] : null;
const query = args.filter((a) => !a.startsWith("--")).join(" ") || "OpenAI 最新发布了什么产品？";

// ========== 获取可用模型列表 ==========
// codex /models 返回 { models: [...] }，模型标识字段为 slug
async function fetchModels() {
  const endpoint = `${BASE_URL.replace(/\/$/, "")}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`;
  const headers = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    Accept: "application/json",
  };
  if (ACCOUNT_ID) headers["ChatGPT-Account-ID"] = ACCOUNT_ID;

  const res = await fetch(endpoint, { headers });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`获取模型列表失败 HTTP ${res.status}: ${errText}`);
    process.exit(1);
  }

  const data = await res.json();
  const models = data.models || [];

  if (!models.length) {
    console.error("模型列表为空");
    console.error("原始响应:", JSON.stringify(data, null, 2));
    process.exit(1);
  }

  return models;
}

async function fetchDefaultModel() {
  const models = await fetchModels();
  const defaultModel = models.find((m) => m.is_default) || models[0];
  const modelId = defaultModel.slug || defaultModel.id || defaultModel.model;
  console.log(`📋 可用模型 ${models.length} 个，默认: ${modelId}`);
  return modelId;
}

async function listModels() {
  const models = await fetchModels();
  console.log(`\n📋 可用模型列表 (${models.length} 个):\n`);
  for (const m of models) {
    const id = m.slug || m.id || m.model;
    const name = m.display_name || id;
    const isDefault = m.is_default ? " [默认]" : "";
    console.log(`  • ${name}${isDefault}`);
    console.log(`    ID: ${id}`);
    if (m.description) console.log(`    描述: ${m.description}`);
    if (m.context_window) console.log(`    上下文: ${m.context_window}`);
    console.log();
  }
}

// ========== 图像生成探测（走 codex 后端 /images/generations，消耗订阅额度） ==========
// 注意：后端不校验 model 字段——任意字符串都返回 200，body/headers 也不 echo 实际模型。
// 因此 probe 只能证明端点可用且额度充足，不能证明指定模型真的被使用。
async function probeImageGeneration(model) {
  const endpoint = `${BASE_URL.replace(/\/$/, "")}/images/generations`;
  const headers = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (ACCOUNT_ID) headers["ChatGPT-Account-ID"] = ACCOUNT_ID;

  const body = {
    model,
    prompt: "a plain solid blue circle on a white background",
    n: 1,
    quality: "low",
    size: "1024x1024",
  };

  console.log(`🧪 探测模型: ${model}`);
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();

  if (!res.ok) {
    console.log(`❌ HTTP ${res.status}`);
    console.log(text.slice(0, 2000));
    process.exitCode = 1;
    return;
  }

  const data = JSON.parse(text);
  const item = (data.data || [])[0] || {};
  console.log("✅ 生成成功");
  if (item.b64_json) console.log(`   b64_json: <${item.b64_json.length} chars, 未打印>`);
  if (item.url) console.log(`   url: ${item.url}`);
  if (data.usage) console.log(`   usage: ${JSON.stringify(data.usage)}`);
  console.log(`   其余字段: ${Object.keys(data).join(", ")}`);
}

// ========== 构造 Responses API 请求体 ==========
// 参考 codex-rs/codex-api/src/common.rs 中 ResponsesApiRequest 的字段
function buildRequestBody(userQuery, model) {
  const webSearchTool = {
    type: "web_search",
    external_web_access: WEB_SEARCH_MODE === "live",
    search_context_size: SEARCH_CONTEXT_SIZE,
  };

  return {
    model,
    instructions:
      "You are a helpful assistant with access to web search. " +
      "When answering, cite your sources using the annotations provided by the search tool.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userQuery }],
      },
    ],
    tools: [webSearchTool],
    // "auto" 让模型自行决定是否调用 web_search;
    // "required" 强制模型至少调用一次工具（推荐用于测试，确保搜索一定触发）
    tool_choice: "required",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  };
}

// ========== SSE 流解析 ==========
async function* parseSSE(responseBody) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // 事件状态必须跨 read 保留：网络分片可能把 event: 和 data: 拆到两个 chunk
  let eventType = "";
  let eventData = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        eventData = line.slice(5).trim();
      } else if (line.trim() === "" && eventData) {
        if (eventData === "[DONE]") return;
        try {
          yield { type: eventType, data: JSON.parse(eventData) };
        } catch {
          yield { type: eventType, raw: eventData };
        }
        eventType = "";
        eventData = "";
      }
    }
  }
}

// ========== 主流程 ==========
async function main() {
  if (IMAGE_PROBE_MODEL) {
    await probeImageGeneration(IMAGE_PROBE_MODEL);
    return;
  }
  if (LIST_MODELS_ONLY) {
    await listModels();
    return;
  }

  console.log(`🔌 Base URL: ${BASE_URL}`);
  console.log(`🔍 Web Search Mode: ${WEB_SEARCH_MODE}`);
  console.log(`💬 Query: ${query}\n`);

  const model = OVERRIDE_MODEL || (await fetchDefaultModel());
  console.log(`🧠 Model: ${model}\n`);

  const body = buildRequestBody(query, model);
  const endpoint = `${BASE_URL.replace(/\/$/, "")}/responses`;

  const headers = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (ACCOUNT_ID) headers["ChatGPT-Account-ID"] = ACCOUNT_ID;

  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`HTTP ${res.status}: ${errText}`);
    process.exit(1);
  }

  let responseId = "";
  const assistantTextParts = [];
  const searchCalls = [];
  let usage = null;

  for await (const event of parseSSE(res.body)) {
    const { type, data } = event;

    switch (type) {
      case "response.created": {
        responseId = data.response?.id || "";
        console.log(`📡 Response created: ${responseId}\n`);
        break;
      }

      case "response.output_item.added": {
        const item = data.item;
        if (item?.type === "web_search_call") {
          console.log(`🔎 [WebSearch] 开始搜索 (status: ${item.status || "in_progress"})`);
          searchCalls.push({ id: item.id, status: item.status, action: null });
        }
        break;
      }

      case "response.output_item.done": {
        const item = data.item;
        if (item?.type === "web_search_call") {
          const action = item.action;
          const searchQuery = action?.query || action?.queries?.join(", ") || "";
          console.log(`✅ [WebSearch] 搜索完成`);
          console.log(`   ID: ${item.id}`);
          console.log(`   Status: ${item.status}`);
          if (action?.type) console.log(`   Action Type: ${action.type}`);
          if (searchQuery) console.log(`   Query: ${searchQuery}\n`);
          else if (action?.url) {
            console.log(`   URL: ${action.url}`);
            if (action?.pattern) console.log(`   Pattern: ${action.pattern}`);
            console.log();
          }
          const call = searchCalls.find((c) => c.id === item.id);
          if (call) call.action = action;
        }
        if (item?.type === "message" && item.role === "assistant") {
          const content = item.content || [];
          for (const part of content) {
            if (part.type === "output_text") {
              assistantTextParts.push(part.text);
              // url_citation 注解（如果 API 返回）
              if (part.annotations?.length) {
                console.log(`\n📎 [Citations] ${part.annotations.length} 条引用:`);
                for (const ann of part.annotations) {
                  if (ann.type === "url_citation") {
                    console.log(`   - [${ann.title || "未知来源"}] ${ann.url}`);
                  }
                }
              }
            }
          }
        }
        break;
      }

      case "response.output_text.delta": {
        process.stdout.write(data.delta || "");
        break;
      }

      case "response.completed": {
        usage = data.response?.usage;
        console.log("\n\n✨ Response completed");
        break;
      }

      case "response.failed": {
        console.error("\n❌ Response failed:", JSON.stringify(data, null, 2));
        process.exit(1);
      }

      default:
        break;
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📊 汇总");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (searchCalls.length > 0) {
    console.log(`\n🔍 共发起 ${searchCalls.length} 次 Web Search:`);
    for (const call of searchCalls) {
      const q = call.action?.query || call.action?.queries?.[0] || "N/A";
      console.log(`   • ${q}`);
    }
  } else {
    console.log("\n⚠️ 本次请求未触发 Web Search");
  }

  console.log("\n📝 完整回复:");
  console.log(assistantTextParts.join("") || "(无文本输出)");

  if (usage) {
    console.log("\n📈 Token Usage:");
    console.log(`   Input:  ${usage.input_tokens || 0}`);
    console.log(`   Output: ${usage.output_tokens || 0}`);
    console.log(`   Total:  ${usage.total_tokens || 0}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
