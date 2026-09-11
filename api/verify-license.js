// Vercel serverless function for Figma plugin license verification with Gumroad

const EXPECTED_PLUGIN_ID = '1628606719614616142';
const ALLOWED_ORIGINS = ['https://www.figma.com', 'https://figma.com'];

function setCorsHeaders(res, reqOrigin) {
  // Figma plugin UIs run in sandboxed iframes (null origin) or from figma.com
  const isNull = !reqOrigin || reqOrigin === 'null';
  const isAllowed = isNull || ALLOWED_ORIGINS.includes(reqOrigin);
  res.setHeader('Access-Control-Allow-Origin', isNull ? 'null' : (isAllowed ? reqOrigin : 'null'));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  const reqOrigin = req.headers.origin;
  setCorsHeaders(res, reqOrigin);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      valid: false,
      tier: null,
      email: null,
      error: 'Method not allowed',
    });
  }

  const productId = process.env.GUMROAD_PRODUCT_ID;
  if (!productId) {
    return res.status(500).json({
      valid: false,
      tier: null,
      email: null,
      error: 'GUMROAD_PRODUCT_ID is not configured',
    });
  }

  try {
    let body = req.body;
    if (!body || typeof body === 'string') {
      try {
        body = body ? JSON.parse(body) : {};
      } catch {
        body = {};
      }
    }

    const { license_key, plugin_id } = body || {};

    if (!license_key) {
      return res.status(400).json({
        valid: false,
        tier: null,
        email: null,
        error: 'license_key is required',
      });
    }

    if (!plugin_id) {
      return res.status(400).json({
        valid: false,
        tier: null,
        email: null,
        error: 'plugin_id is required',
      });
    }

    if (plugin_id !== EXPECTED_PLUGIN_ID) {
      return res.status(403).json({
        valid: false,
        tier: null,
        email: null,
        error: 'Invalid plugin_id',
      });
    }

    const params = new URLSearchParams();
    params.append('product_id', productId);
    params.append('license_key', license_key);
    params.append('increment_uses_count', 'false');

    const gumroadResponse = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!gumroadResponse.ok) {
      // 404 = license key doesn't exist → not an error, just invalid
      if (gumroadResponse.status === 404) {
        return res.status(200).json({ valid: false, tier: null, email: null });
      }
      const text = await gumroadResponse.text();
      console.error('Gumroad verification failed:', gumroadResponse.status, text);
      return res.status(502).json({
        valid: false,
        tier: null,
        email: null,
        error: 'Failed to verify license with Gumroad',
      });
    }

    const data = await gumroadResponse.json();

    let valid = false;
    let tier = null;
    let email = null;

    if (data && data.success && data.purchase) {
      const p = data.purchase;

      const refunded = Boolean(p.refunded);
      const chargebacked = Boolean(p.chargebacked);
      const subscriptionEnded = Boolean(p.subscription_ended_at);
      const subscriptionCancelled = Boolean(p.subscription_cancelled_at);
      const subscriptionFailed = Boolean(p.subscription_failed_at);
      const subscriptionActive = !subscriptionEnded && !subscriptionCancelled && !subscriptionFailed;

      valid = !refunded && !chargebacked && subscriptionActive;

      if (p.variants && typeof p.variants === 'string' && p.variants.trim().length > 0) {
        tier = p.variants.trim();
      } else if (Array.isArray(p.variants) && p.variants.length > 0) {
        tier = p.variants.join(',').trim();
      } else {
        tier = 'default';
      }

      email = p.email || null;
    }

    return res.status(200).json({ valid, tier, email });
  } catch (error) {
    console.error('Unexpected error during license verification:', error);
    return res.status(500).json({
      valid: false,
      tier: null,
      email: null,
      error: 'Internal server error',
    });
  }
}
