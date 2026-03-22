const SUPABASE_URL = "https://kzyubvtsvrwwvmagppho.supabase.co";
const SUPABASE_KEY = "sb_publishable_k0UKHKu-84br_grFLjOfVQ_w9EjA2kg";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    // Step 1: Get results via vector search (if embeddings available) + text fallback
    const [vectorResults, textResults] = await Promise.all([
      openaiKey ? searchByVector(openaiKey, query) : Promise.resolve([]),
      searchByText(query),
    ]);

    // Merge and deduplicate, preferring vector results
    const seen = new Set();
    const allResults = [];
    for (const r of [...vectorResults, ...textResults]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        allResults.push(r);
      }
    }

    if (allResults.length === 0) {
      return res.status(200).json({ answer: "No matching items found in your knowledge base.", sources: [] });
    }

    // Step 2: Build context from top results and ask Claude to synthesize an answer
    const top = allResults.slice(0, 15);
    const context = top.map((item, i) =>
      `[${i + 1}] "${item.title}" (${item.source_type})${item.channel ? ` by ${item.channel}` : ""}\n` +
      (item.summary ? `Summary: ${item.summary.substring(0, 500)}\n` : "") +
      (item.takeaways?.length ? `Takeaways: ${item.takeaways.slice(0, 5).join("; ")}\n` : "") +
      (item.quotes?.length ? `Key quotes: ${item.quotes.slice(0, 3).map(q => `"${q.substring(0, 150)}"`).join("; ")}\n` : "")
    ).join("\n---\n");

    const answerPrompt = `You are a personal knowledge assistant. The user is searching their saved knowledge base. Answer their question using ONLY the sources provided below. Cite sources using [1], [2], etc.

Be concise and specific. If the sources don't contain enough info to answer, say so.

User's question: ${query}

Sources from their knowledge base:
${context}

Answer (cite sources with [N]):`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        messages: [{ role: "user", content: answerPrompt }],
      }),
    });

    if (!claudeRes.ok) throw new Error("Claude API error: " + claudeRes.status);
    const claudeData = await claudeRes.json();
    const answer = claudeData.content?.[0]?.text || "Unable to generate answer.";

    res.status(200).json({
      answer,
      sources: top.map((item, i) => ({
        index: i + 1,
        id: item.id,
        source_table: item.source_table,
        title: item.title,
        source_type: item.source_type,
        category: item.category,
        url: item.url,
        channel: item.channel || null,
        summary: item.summary ? item.summary.substring(0, 200) : null,
        similarity: item.similarity || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function searchByVector(openaiKey, query) {
  // Generate embedding for the query
  const embRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: query }),
  });
  if (!embRes.ok) return [];
  const embData = await embRes.json();
  const embedding = embData.data?.[0]?.embedding;
  if (!embedding) return [];

  // Call Supabase RPC for vector search
  try {
    const results = await supaFetch("rpc/search_knowledge", {
      method: "POST",
      body: JSON.stringify({ query_embedding: embedding, match_count: 20 }),
    });
    return results || [];
  } catch {
    return [];
  }
}

async function searchByText(query) {
  // Fallback text search across both tables
  const words = query.split(/\s+/).filter(w => w.length > 2).slice(0, 5);
  if (words.length === 0) return [];

  // Build PostgREST or filter: title or summary contains any word
  const orClauses = words.flatMap(w => [
    "title.ilike.*" + encodeURIComponent(w) + "*",
    "summary.ilike.*" + encodeURIComponent(w) + "*",
  ]).join(",");

  const [contentResults, podcastResults] = await Promise.all([
    supaFetch("content_items?select=id,title,url,summary,category,source_type,status,key_takeaways,quotes&or=(" + orClauses + ")&limit=10").catch(() => []),
    supaFetch("podcasts?select=id,title,url,youtube_url,summary,category,channel,topics,takeaways,quotes&status=eq.ready&or=(" + orClauses + ")&limit=10").catch(() => []),
  ]);

  const content = (contentResults || []).map(i => ({ ...i, source_table: "content", takeaways: i.key_takeaways }));
  const podcasts = (podcastResults || []).map(i => ({ ...i, source_table: "podcast", source_type: "podcast", url: i.youtube_url || i.url }));
  return [...content, ...podcasts];
}

async function supaFetch(path, opts = {}) {
  const { headers: extraHeaders, ...restOpts } = opts;
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...restOpts,
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", ...extraHeaders },
  });
  if (!res.ok) throw new Error("Supabase error: " + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
