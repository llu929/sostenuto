/**
 * executor.js — pluggable LLM backend for classification.
 *
 * Everything downstream sees one interface:
 *   executor.complete({ system, user, maxTokens }) => Promise<string>
 *
 * Two backends ship; bring your own by matching the shape. (A custom
 * executor is also where cost tricks live if you have them — e.g. routing
 * through infrastructure you already pay for. Sostenuto doesn't care how
 * the text comes back.)
 *
 * Model choice: classification is a structured-extraction task — a fast,
 * cheap model is the right default. Reserve your strongest model for the
 * conversation itself.
 */

const DEFAULT_MAX_TOKENS = 8000;

/** Anthropic Messages API backend. */
export function createAnthropicExecutor({
  apiKey,
  model = "claude-haiku-4-5-20251001",
  baseUrl = "https://api.anthropic.com",
} = {}) {
  if (!apiKey) throw new Error("createAnthropicExecutor: apiKey required");

  async function complete({ system, user, maxTokens = DEFAULT_MAX_TOKENS }) {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    return (json.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  return { complete, model, provider: "anthropic" };
}

/**
 * OpenAI-compatible chat-completions backend.
 * Works with OpenAI, Gemini (OpenAI-compat endpoint), DeepSeek, Ollama,
 * LM Studio, vLLM — anything speaking /v1/chat/completions.
 */
export function createOpenAICompatibleExecutor({ apiKey, model, baseUrl } = {}) {
  if (!baseUrl) throw new Error("createOpenAICompatibleExecutor: baseUrl required");
  if (!model) throw new Error("createOpenAICompatibleExecutor: model required");

  async function complete({ system, user, maxTokens = DEFAULT_MAX_TOKENS }) {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? "";
  }

  return { complete, model, provider: "openai-compatible" };
}

/** Build an executor from environment variables (see .env.example). */
export function executorFromEnv(env = process.env) {
  if (env.CLASSIFY_BASE_URL) {
    return createOpenAICompatibleExecutor({
      baseUrl: env.CLASSIFY_BASE_URL,
      apiKey: env.CLASSIFY_API_KEY,
      model: env.CLASSIFY_MODEL,
    });
  }
  if (env.ANTHROPIC_API_KEY) {
    return createAnthropicExecutor({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.CLASSIFY_MODEL ? { model: env.CLASSIFY_MODEL } : {}),
    });
  }
  throw new Error(
    "No classification backend configured: set ANTHROPIC_API_KEY or CLASSIFY_BASE_URL (+ CLASSIFY_MODEL)"
  );
}
