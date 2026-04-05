const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const ALLOWED_PATHS = ["content_items", "podcasts", "kb_digests", "rpc/search_knowledge"];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: "Supabase not configured" });

  const { path, method = "GET", body, headers: extraHeaders = {} } = req.body;
  if (!path) return res.status(400).json({ error: "Missing path" });

  // Validate path against allowlist
  if (path.includes("..") || path.startsWith("/") || path.startsWith("http")) {
    return res.status(400).json({ error: "Invalid path" });
  }
  const pathPrefix = path.split("?")[0].split("/")[0];
  const rpcPath = path.startsWith("rpc/") ? path.split("?")[0] : null;
  if (!ALLOWED_PATHS.includes(pathPrefix) && !ALLOWED_PATHS.includes(rpcPath)) {
    return res.status(403).json({ error: "Path not allowed" });
  }

  // Only allow safe methods
  const allowedMethods = ["GET", "POST", "PATCH", "DELETE"];
  if (!allowedMethods.includes(method.toUpperCase())) {
    return res.status(400).json({ error: "Method not allowed" });
  }

  try {
    const fetchOpts = {
      method: method.toUpperCase(),
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
      },
    };

    // Forward Prefer header if provided (needed for return=representation)
    if (extraHeaders.Prefer || extraHeaders.prefer) {
      fetchOpts.headers.Prefer = extraHeaders.Prefer || extraHeaders.prefer;
    }

    if (body && (method === "POST" || method === "PATCH" || method === "PUT")) {
      fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, fetchOpts);
    const text = await response.text();
    res.status(response.status).setHeader("Content-Type", "application/json").send(text);
  } catch (e) {
    res.status(502).json({ error: "Supabase proxy error: " + e.message });
  }
}
