// Gemini generateContent REST client for Vercel serverless functions.
// No SDK — fetch only.

const DEFAULT_PROVIDER = "gemini";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const LLM_TIMEOUT_MS = 10000;
const RATE_LIMIT_USER_MESSAGE = "지금 요청이 많아서 잠시 후 다시 시도해주세요";

const PROVIDERS = {
  gemini: {
    name: "gemini",
    model: GEMINI_MODEL,
    apiKey: () => process.env.GEMINI_API_KEY,
  },
};

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const e = new Error(`LLM request timed out after ${ms}ms`);
        e.status = 504;
        reject(e);
      }, ms)
    ),
  ]);
}

function isQuotaOrRateLimit(status, bodyText) {
  if (status === 429) return true;
  const t = String(bodyText || "").toLowerCase();
  return (
    status === 403 &&
    (t.includes("resource_exhausted") ||
      t.includes("quota") ||
      t.includes("rate limit") ||
      t.includes("rate_limit") ||
      t.includes("exceeded your current quota"))
  );
}

function rateLimitError() {
  const e = new Error(RATE_LIMIT_USER_MESSAGE);
  e.status = 429;
  return e;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    const block = data?.promptFeedback?.blockReason;
    if (block) throw new Error(`Gemini blocked the prompt (${block})`);
    throw new Error("Empty Gemini response");
  }
  return parts
    .map((p) => (p && typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

async function callGemini({ system, user, jsonMode, maxTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const generationConfig = {
    temperature: 0.3,
    maxOutputTokens: maxTokens,
  };
  if (jsonMode) {
    generationConfig.responseMimeType = "application/json";
  }

  const body = {
    systemInstruction: {
      parts: [{ text: system || "" }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: user || "" }],
      },
    ],
    generationConfig,
  };

  const url = `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`;
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    LLM_TIMEOUT_MS
  );

  const text = await res.text();
  if (!res.ok) {
    if (isQuotaOrRateLimit(res.status, text)) throw rateLimitError();
    const e = new Error(`gemini API ${res.status}: ${text.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned a non-JSON body");
  }

  return extractGeminiText(data);
}

/**
 * @param {{ system: string, user: string, jsonMode?: boolean, maxTokens?: number, provider?: string }} opts
 * @returns {Promise<string>}
 */
export async function callLLM({ system, user, jsonMode = false, maxTokens = 1024, provider } = {}) {
  const name = provider || DEFAULT_PROVIDER;
  const config = PROVIDERS[name];
  if (!config) throw new Error(`Unknown LLM provider: ${name}`);

  const key = config.apiKey();
  if (!key) {
    const e = new Error("GEMINI_API_KEY is not configured");
    e.status = 503;
    throw e;
  }

  return callGemini({ system, user, jsonMode, maxTokens });
}

/**
 * Parse JSON from LLM output, stripping markdown fences and leading prose.
 */
export function safeJsonParse(raw) {
  if (!raw) throw new Error("Empty LLM response");
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const firstBrace = Math.min(
    ...["{", "["].map((c) => {
      const i = s.indexOf(c);
      return i === -1 ? Infinity : i;
    })
  );
  if (firstBrace === Infinity) throw new Error("No JSON found in LLM response");
  const lastBrace = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastBrace === -1 || lastBrace < firstBrace) throw new Error("Malformed JSON in LLM response");
  return JSON.parse(s.slice(firstBrace, lastBrace + 1));
}

export { DEFAULT_PROVIDER, PROVIDERS, GEMINI_MODEL };
