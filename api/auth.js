const PASSWORD = '9Ldoms0zwH627mfv';
const COOKIE_NAME = 'pke_auth';

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body;

  if (password === PASSWORD) {
    // Set cookie for 30 days
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${PASSWORD}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}`);
    return res.status(200).json({ success: true });
  }

  return res.status(401).json({ error: 'Invalid password' });
}
