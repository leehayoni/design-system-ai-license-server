export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  
    const { license_key } = req.body;
  
    if (license_key === "test-premium") {
      return res.status(200).json({
        valid: true,
        tier: "premium"
      });
    }
  
    return res.status(200).json({
      valid: false
    });
  }