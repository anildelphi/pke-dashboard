import { NextResponse } from "next/server";

const COOKIE_NAME = "pke_session";

const PUBLIC_PATHS = ["/login", "/login.html", "/api/auth", "/favicon.png"];

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  // Allow Vercel cron requests to kb-digest
  if (pathname === "/api/kb-digest" && request.headers.get("x-vercel-cron")) {
    return NextResponse.next();
  }

  // Validate session cookie
  const cookie = request.cookies.get(COOKIE_NAME);
  if (!cookie?.value) {
    return denyAccess(request, pathname);
  }

  const parts = cookie.value.split(".");
  if (parts.length !== 2) {
    return denyAccess(request, pathname);
  }

  const [token, signature] = parts;
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return denyAccess(request, pathname);
  }

  // Verify HMAC signature using Web Crypto API (Edge Runtime compatible)
  const valid = await verifyHmac(secret, token, signature);
  if (!valid) {
    return denyAccess(request, pathname);
  }

  return NextResponse.next();
}

async function verifyHmac(secret, token, signature) {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(token)
    );
    const expected = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return expected === signature;
  } catch {
    return false;
  }
}

function denyAccess(request, pathname) {
  if (pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|_vercel).*)"],
};
