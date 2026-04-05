import {
  generateSessionToken,
  makeSessionCookie,
  clearSessionCookie,
  validateSession,
} from "./_lib/auth.js";

export default function handler(req, res) {
  if (req.method === "GET") {
    // Session check — is the user already authenticated?
    if (validateSession(req)) {
      return res.status(200).json({ authenticated: true });
    }
    return res.status(401).json({ authenticated: false });
  }

  if (req.method === "POST") {
    // Login
    const { password } = req.body || {};
    const expected = process.env.PKE_PASSWORD;
    if (!expected) return res.status(500).json({ error: "Password not configured" });

    if (password === expected) {
      const token = generateSessionToken();
      res.setHeader("Set-Cookie", makeSessionCookie(token));
      return res.status(200).json({ success: true });
    }
    return res.status(401).json({ error: "Invalid password" });
  }

  if (req.method === "DELETE") {
    // Logout
    res.setHeader("Set-Cookie", clearSessionCookie());
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
