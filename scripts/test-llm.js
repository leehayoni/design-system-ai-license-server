// Test script for Gemini LLM provider
// Usage: node scripts/test-llm.js
// Requires: .env file with GEMINI_API_KEY

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env manually (no dotenv dependency needed)
try {
  const envPath = resolve(__dirname, '../.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — assume env vars are already set
}

const { callLLM, safeJsonParse, DEFAULT_PROVIDER } = await import('../api/_lib/llm-provider.js');

const TESTS = [
  {
    name: 'naming (JSON)',
    system: 'You are a design system engineer. Return ONLY valid JSON. No markdown.',
    user: 'Name these tokens semantically:\n{"colors":["#3100B5","#FFFFFF","#191F28"]}\n\nReturn: [{"type":"color","value":"#3100B5","name":"color-brand-primary"}]',
    jsonMode: true,
  },
  {
    name: 'recommendation (prose)',
    system: 'You are a design advisor. Be concise.',
    user: 'Consistency score: 42/100. Found 3 duplicate color groups. Give one 🔴 recommendation under 20 words.',
    jsonMode: false,
  },
];

console.log(`\n🤖 Testing LLM provider: ${DEFAULT_PROVIDER.toUpperCase()}\n${'─'.repeat(50)}`);

let passed = 0;
let failed = 0;

for (const test of TESTS) {
  process.stdout.write(`Testing "${test.name}"... `);
  const start = Date.now();
  try {
    const raw = await callLLM({
      system: test.system,
      user: test.user,
      jsonMode: test.jsonMode,
      maxTokens: 300,
    });
    const elapsed = Date.now() - start;

    if (test.jsonMode) {
      const parsed = safeJsonParse(raw);
      console.log(`✓ ${elapsed}ms — parsed JSON: ${JSON.stringify(parsed).slice(0, 80)}…`);
    } else {
      console.log(`✓ ${elapsed}ms — "${raw.trim().slice(0, 80)}"`);
    }
    passed++;
  } catch (err) {
    console.log(`✗ FAILED: ${err.message}`);
    failed++;
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
