# Design System AI — License Server

Vercel serverless backend for the Design System AI Figma plugin.

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/verify-license` | Validate Gumroad license key |
| POST | `/api/ai-suggest` | AI-powered design system analysis |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GUMROAD_PRODUCT_ID` | Yes | Gumroad product ID for license verification |
| `GEMINI_API_KEY` | Yes (for `/api/ai-suggest`) | Google AI Studio API key |

Copy `.env.example` to `.env` for local development.

## LLM Provider

`api/_lib/llm-provider.js` calls Gemini REST (`generateContent`), model `gemini-3.5-flash-lite`. No LLM SDK is installed.

- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent`
- JSON tasks set `generationConfig.responseMimeType` to `application/json`
- Missing `GEMINI_API_KEY` returns HTTP 503
- Gemini 429 / quota exhaustion returns HTTP 429 with a retry message

Get a key: [Google AI Studio](https://aistudio.google.com/apikey)

## Rate Limits

Plugin-side daily caps (in-memory per Vercel instance), separate from Gemini free-tier RPM/RPD:

| Tier | Daily AI calls |
|---|---|
| Free | 5 |
| Pro | 100 |

## Deployment

```bash
vercel --prod
```

Ensure `GEMINI_API_KEY` is set in the Vercel project (Production).

## Local Testing

```bash
cp .env.example .env
# Set GEMINI_API_KEY
node scripts/test-llm.js
```
