import crypto from "crypto";

const COOKIE_NAME = "pke_session";

export function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function signToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET not configured");
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

export function makeSessionCookie(token) {
  const signature = signToken(token);
  const value = token + "." + signature;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function validateSession(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  const [token, signature] = parts;
  const expected = signToken(token);

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}
