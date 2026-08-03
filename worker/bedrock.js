// Claude-via-AWS-Bedrock path — an opt-in, parallel replacement for the
// OpenAI calls in worker/index.js, selected by the LLM_PROVIDER env var
// (see withLlmProvider() there). Entirely self-contained: deleting this file
// and the small `model.bedrock` dispatch branches in worker/index.js fully
// reverts to OpenAI-only with no other changes needed.
//
// Talks to the Bedrock Runtime "converse" HTTP API directly (no AWS SDK / no
// SigV4 — the deployed key is a Bedrock API key used as a plain bearer token,
// same shape as the OpenAI calls it stands in for).
//
// bedrockChat() / bedrockJson() mirror openaiChat() / openaiJson()'s exact
// input and return shapes: a trimmed string, and a best-effort-parsed object
// (or {} on unparseable output), respectively — so callers can't tell which
// provider answered.

const DEFAULT_REGION = "us-east-1";
// ASSUMPTION — verify against the target AWS account before relying on this:
// model id + region default to Claude Sonnet 4.5 in us-east-1. Override via
// the BEDROCK_MODEL_ID / BEDROCK_REGION env vars if the account uses a
// different region or model.
const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export function bedrockModelConfig(env) {
  return {
    bedrock: true,
    modelId: env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID,
    region: env.BEDROCK_REGION || DEFAULT_REGION,
  };
}

// OpenAI-style {role, content} messages -> Bedrock Converse's shape, which
// keeps system prompts in their own top-level array instead of inline.
function toBedrockRequest(messages) {
  const system = [];
  const conversation = [];
  for (const m of messages || []) {
    const text = String((m && m.content) || "");
    if (!text) continue;
    if (m.role === "system") system.push({ text });
    else conversation.push({ role: m.role === "assistant" ? "assistant" : "user", content: [{ text }] });
  }
  return { system, conversation };
}

async function converse(apiKey, model, messages, maxTokens, temperature) {
  const { system, conversation } = toBedrockRequest(messages);
  const endpoint =
    `https://bedrock-runtime.${model.region}.amazonaws.com/model/${encodeURIComponent(model.modelId)}/converse`;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: conversation,
      system,
      inferenceConfig: { maxTokens, temperature },
    }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    throw new Error((data && data.message) || `HTTP ${upstream.status}`);
  }
  const blocks = data && data.output && data.output.message && data.output.message.content;
  return Array.isArray(blocks) ? blocks.map((b) => (b && b.text) || "").join("") : "";
}

// Mirrors openaiChat()'s return shape: a trimmed plain string.
export async function bedrockChat(apiKey, model, messages, maxTokens, temperature = 0.2) {
  const text = await converse(apiKey, model, messages, maxTokens, temperature);
  return String(text || "").trim();
}

// Bedrock Converse has no "response_format: json_object" equivalent, so the
// JSON contract is enforced with an extra system nudge instead, mirroring
// openaiJson()'s return shape: the parsed object, or {} on unparseable output.
const JSON_NUDGE = {
  role: "system",
  content:
    "Respond with ONLY a single valid JSON object as your entire reply — no markdown code fences, " +
    "no commentary, nothing before or after it.",
};

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

export async function bedrockJson(apiKey, model, messages, maxTokens) {
  const text = await converse(apiKey, model, [...(messages || []), JSON_NUDGE], maxTokens, 0.2);
  try {
    return JSON.parse(extractJsonObject(text));
  } catch {
    return {};
  }
}
