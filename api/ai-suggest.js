// POST /api/ai-suggest
// Body: { license_key, plugin_id, task, data }
// Returns: { suggestions, isPro, remaining, provider }

import { callLLM, safeJsonParse, DEFAULT_PROVIDER } from './_lib/llm-provider.js';

const EXPECTED_PLUGIN_ID = '1628606719614616142';
const ALLOWED_ORIGINS = ['https://www.figma.com', 'https://figma.com'];

// ── Rate limiting (in-memory per instance) ─────────────────────────────────
// Upgrade to Upstash Redis for cross-instance persistence when needed.
const _rateLimitStore = new Map();
const RATE_LIMITS = { pro: 100, free: 5 };
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

function checkRateLimit(identifier, isPro) {
  const limit = isPro ? RATE_LIMITS.pro : RATE_LIMITS.free;
  const now = Date.now();
  const entry = _rateLimitStore.get(identifier);
  if (!entry || entry.resetAt < now) {
    _rateLimitStore.set(identifier, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, remaining: limit - 1 };
  }
  if (entry.count >= limit) return { allowed: false, remaining: 0 };
  entry.count++;
  return { allowed: true, remaining: limit - entry.count };
}

// ── Cost guardrail ─────────────────────────────────────────────────────────
const MAX_INPUT_CHARS = 12000;

function truncateInput(str) {
  return str.length <= MAX_INPUT_CHARS ? str : str.slice(0, MAX_INPUT_CHARS) + '\n[truncated]';
}

// ── CORS ───────────────────────────────────────────────────────────────────
function setCorsHeaders(res, reqOrigin) {
  const isNull = !reqOrigin || reqOrigin === 'null';
  const isAllowed = isNull || ALLOWED_ORIGINS.includes(reqOrigin);
  res.setHeader('Access-Control-Allow-Origin', isNull ? 'null' : (isAllowed ? reqOrigin : 'null'));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── License verification ───────────────────────────────────────────────────
async function verifyLicense(license_key) {
  const productId = process.env.GUMROAD_PRODUCT_ID;
  if (!productId || !license_key) return { valid: false };
  const params = new URLSearchParams();
  params.append('product_id', productId);
  params.append('license_key', license_key);
  params.append('increment_uses_count', 'false');
  try {
    const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { valid: false };
    const data = await res.json();
    if (!data?.success || !data?.purchase) return { valid: false };
    const p = data.purchase;
    const valid = !p.refunded && !p.chargebacked &&
      !p.subscription_ended_at && !p.subscription_cancelled_at && !p.subscription_failed_at;
    return { valid };
  } catch {
    return { valid: false };
  }
}

// ── Task prompts (tuned for both Llama 3.3 and Claude Haiku) ──────────────
// Rules are numbered + markdown for Llama; Anthropic path appends JSON guard automatically.
const TASKS = {
  naming: {
    system: `You are a senior design system engineer specializing in semantic token naming.

Rules:
1. Use kebab-case only (e.g., color-brand-primary).
2. Use semantic names, NOT literal ones (color-action-primary, NOT color-blue).
3. For grays, use a scale: color-gray-50 through color-gray-900.
4. For spacing, map to 4pt grid names: space-1 (4px), space-2 (8px), space-4 (16px), space-6 (24px), space-8 (32px).
5. For typography, use: text-xs, text-sm, text-base, text-lg, text-xl, text-2xl.
6. Return ONLY a JSON array. No prose. No markdown fences.`,
    buildUser: (data, isPro) => {
      const limit = isPro ? 9999 : 3;
      const tokens = data.tokens || {};
      const payload = {
        colors: (tokens.colors || []).slice(0, limit),
        spacing: (tokens.spacing || []).slice(0, limit),
        radius: (tokens.radius || []).slice(0, limit),
        typography: (tokens.typography || []).slice(0, limit),
      };
      return `Generate semantic names for these tokens:\n${truncateInput(JSON.stringify(payload, null, 2))}\n\nOutput JSON array:\n[{"type":"color","value":"#3100B5","name":"color-brand-primary","category":"brand"}]`;
    },
    jsonMode: true,
    maxTokens: 1500,
  },

  refactor: {
    system: `You are a design system auditor specializing in finding tokens that should be merged.

Rules:
1. Flag colors within 5 HSL units of each other.
2. Flag spacing values differing by less than 2px.
3. Pick the most "canonical" value (rounded or most common) as recommended.
4. Write one short sentence per finding explaining why.
5. Return ONLY a JSON array. No prose. No markdown fences.`,
    buildUser: (data) =>
      `Find near-duplicate tokens:\n${truncateInput(JSON.stringify(data.groups || [], null, 2))}\n\nOutput JSON array:\n[{"issue":"3 similar grays","tokens":["#8B95A1","#8C95A2","#8B95A0"],"recommended":"#8B95A1","reason":"Max HSL distance is 2 — visually indistinguishable.","category":"color"}]`,
    jsonMode: true,
    maxTokens: 1024,
  },

  a11y: {
    system: `You are a WCAG 2.2 accessibility auditor.

Rules:
1. Compute relative luminance: convert sRGB → linear RGB → Y = 0.2126R + 0.7152G + 0.0722B.
2. Contrast ratio = (lighter + 0.05) / (darker + 0.05). Round to 2 decimal places.
3. WCAG AA: ratio ≥ 4.5 (normal text) or ≥ 3.0 (large text / UI components).
4. WCAG AAA: ratio ≥ 7.0 (normal text) or ≥ 4.5 (large text).
5. For failures, suggest the closest accessible alternative (adjust lightness only).
6. Return ONLY a JSON array. No prose. No markdown fences.`,
    buildUser: (data) =>
      `Audit these color pairs:\n${truncateInput(JSON.stringify(data.pairs || [], null, 2))}\n\nOutput JSON array:\n[{"fg":"#3100B5","bg":"#FFFFFF","ratio":11.20,"AA":true,"AAA":true,"recommendation":null}]`,
    jsonMode: true,
    maxTokens: 1024,
  },

  recommendation: {
    system: `You are a senior design system advisor.

Rules:
1. Each recommendation must be specific to the data — never generic advice.
2. Prefix each line with one emoji: 🔴 (Critical), 🟠 (Warning), 🔵 (Info).
3. Keep each recommendation under 30 words.
4. Order by priority: Critical first.
5. Write 3–5 recommendations. Plain prose, one per line. No JSON, no markdown.`,
    buildUser: (data) =>
      `Audit summary:\n${truncateInput(JSON.stringify(data.audit || {}, null, 2))}\n\nWrite 3–5 prioritized recommendations:`,
    jsonMode: false,
    maxTokens: 512,
  },
};

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const reqOrigin = req.headers.origin;
  setCorsHeaders(res, reqOrigin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = body ? JSON.parse(body) : {}; } catch { body = {}; }
  }

  const { license_key, plugin_id, task, data } = body || {};

  if (plugin_id !== EXPECTED_PLUGIN_ID) {
    return res.status(403).json({ error: 'Invalid plugin_id' });
  }

  if (!TASKS[task]) {
    return res.status(400).json({ error: `Invalid task. Allowed: ${Object.keys(TASKS).join(', ')}` });
  }

  // Verify license
  let isPro = false;
  if (license_key) {
    const result = await verifyLicense(license_key);
    isPro = result.valid;
  }

  // Rate limit
  const rlKey = license_key ? `key:${license_key}` : `ip:${req.headers['x-forwarded-for'] || 'unknown'}`;
  const rl = checkRateLimit(rlKey, isPro);
  if (!rl.allowed) {
    const limit = isPro ? RATE_LIMITS.pro : RATE_LIMITS.free;
    return res.status(429).json({
      error: `Daily AI limit reached (${limit} calls/day). Resets in 24h.`,
      rateLimited: true,
    });
  }

  const taskDef = TASKS[task];

  try {
    const raw = await callLLM({
      system: taskDef.system,
      user: taskDef.buildUser(data || {}, isPro),
      jsonMode: taskDef.jsonMode,
      maxTokens: taskDef.maxTokens,
    });

    if (!taskDef.jsonMode) {
      return res.status(200).json({
        suggestions: raw.trim(),
        isPro,
        remaining: rl.remaining,
        provider: DEFAULT_PROVIDER,
      });
    }

    try {
      const parsed = safeJsonParse(raw);
      return res.status(200).json({
        suggestions: parsed,
        isPro,
        remaining: rl.remaining,
        provider: DEFAULT_PROVIDER,
      });
    } catch (parseErr) {
      console.error('[ai-suggest] JSON parse failed:', parseErr.message, '\nRaw:', raw.slice(0, 300));
      return res.status(502).json({
        error: 'AI returned malformed response. Please try again.',
        provider: DEFAULT_PROVIDER,
      });
    }
  } catch (err) {
    console.error('[ai-suggest] error:', err.message);
    const status = err.status || 500;
    if (status === 429) {
      return res.status(429).json({
        error: err.message || '지금 요청이 많아서 잠시 후 다시 시도해주세요',
        rateLimited: true,
      });
    }
    if (status === 503) {
      return res.status(503).json({ error: err.message, offline: true });
    }
    if (status === 504) {
      return res.status(504).json({ error: 'AI request timed out. Please try again.', offline: true });
    }
    return res.status(500).json({ error: 'AI service temporarily unavailable.' });
  }
}
