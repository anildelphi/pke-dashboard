import { supaFetch } from "./_lib/supabase.js";

const CATEGORIES = ["ai", "crypto", "investing", "health", "personal", "delphi", "media", "music", "culture", "tech", "geopolitics", "uncategorized"];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Missing items array" });

  // Process max 3 items per request to stay within Vercel timeout
  const batch = items.slice(0, 3);
  const results = [];

  for (const item of batch) {
    try {
      // Generate summary + category + tags via Claude Haiku (fast & cheap)
      const enrichment = await enrichItem(anthropicKey, item);

      // Patch back to Supabase
      const table = item.source_table === "podcast" ? "podcasts" : "content_items";
      const patchData = {};
      if (enrichment.summary) patchData.summary = enrichment.summary;
      if (enrichment.category && enrichment.category !== "uncategorized") patchData.category = enrichment.category;
      if (table === "content_items") {
        if (enrichment.tags?.length) patchData.tags = enrichment.tags;
        if (enrichment.takeaways?.length) patchData.key_takeaways = enrichment.takeaways;
      }

      // Generate embedding if OpenAI key is available
      const openaiKey = process.env.OPENAI_API_KEY;
      if (openaiKey) {
        const embeddingText = [item.title, enrichment.summary, ...(enrichment.takeaways || [])].filter(Boolean).join(" ");
        const embedding = await generateEmbedding(openaiKey, embeddingText);
        if (embedding) patchData.embedding = embedding;
      }

      if (Object.keys(patchData).length > 0) {
        await supaFetch(`${table}?id=eq.${item.id}`, {
          method: "PATCH",
          body: JSON.stringify(patchData),
        });
      }

      results.push({ id: item.id, status: "ok", summary: enrichment.summary?.substring(0, 100) });
    } catch (e) {
      results.push({ id: item.id, status: "error", error: e.message });
    }
  }

  res.status(200).json({ enriched: results.filter(r => r.status === "ok").length, results });
}

async function enrichItem(apiKey, item) {
  const prompt = `Given this saved content item, generate a concise analysis. Return ONLY valid JSON.

Title: ${item.title || "Untitled"}
URL: ${item.url || "N/A"}
Type: ${item.source_type || "article"}
Existing tags: ${(item.tags || []).join(", ") || "none"}
${item.summary ? `Existing summary: ${item.summary.substring(0, 500)}` : ""}

Return JSON with:
- "summary": 2-3 sentence summary of what this content is about and why it's valuable. If you can infer from the title and URL, do so. Be specific and informative.
- "category": One of: ${CATEGORIES.join(", ")}. Pick the best fit.
- "tags": Array of 3-5 short keyword tags (lowercase, no hashtags)
- "takeaways": Array of 1-3 key insights or reasons this content is worth saving

Return ONLY valid JSON, no markdown fences.`;

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!claudeRes.ok) throw new Error("Claude API error: " + claudeRes.status);
  const data = await claudeRes.json();
  const text = data.content?.[0]?.text || "";
  const jsonStr = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "").trim();
  return JSON.parse(jsonStr);
}

async function generateEmbedding(apiKey, text) {
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.substring(0, 8000) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
}
