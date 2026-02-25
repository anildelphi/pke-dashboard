export default async function handler(req, res) {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: "Missing path parameter" });

  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) return res.status(500).json({ error: "Trello credentials not configured" });

  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.trello.com/1/${path}${sep}key=${key}&token=${token}`;

  try {
    const opts = { method: req.method, headers: { "Content-Type": "application/json" } };
    if (req.method === "PUT" || req.method === "POST") {
      opts.body = JSON.stringify(req.body);
    }
    const response = await fetch(url, opts);
    const data = await response.text();
    res.status(response.status).setHeader("Content-Type", "application/json").send(data);
  } catch (e) {
    res.status(502).json({ error: "Trello API error: " + e.message });
  }
}
