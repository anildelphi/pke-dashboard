const SUPABASE_URL = "https://kzyubvtsvrwwvmagppho.supabase.co";
const SUPABASE_KEY = "sb_publishable_k0UKHKu-84br_grFLjOfVQ_w9EjA2kg";

export default async function handler(req, res) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  if (req.method === "GET") {
    // Return existing digest for a given week, or the latest
    const weekParam = req.query.week; // e.g. "2026-03-16"
    try {
      let digest;
      if (weekParam) {
        const data = await supaFetch("kb_digests?week_start=eq." + weekParam + "&limit=1");
        digest = data?.[0] || null;
      } else {
        const data = await supaFetch("kb_digests?order=week_start.desc&limit=1");
        digest = data?.[0] || null;
      }
      return res.status(200).json({ digest });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  // POST: generate a new digest (optionally send email)
  const isCron = req.headers["x-vercel-cron"] === "true" || req.headers["x-vercel-cron"] === "1";
  const { sendEmail } = req.body || {};

  try {
    // Determine the current week (Monday to Sunday)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() + mondayOffset);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weekStartStr = weekStart.toISOString().split("T")[0];
    const weekEndStr = weekEnd.toISOString().split("T")[0];

    // Fetch items saved this week from both tables
    const [contentItems, podcastItems] = await Promise.all([
      supaFetch("content_items?select=id,title,url,summary,category,source_type,tags,key_takeaways&created_at=gte." + weekStart.toISOString() + "&created_at=lte." + weekEnd.toISOString() + "&order=created_at.desc"),
      supaFetch("podcasts?select=id,title,url,youtube_url,summary,category,channel,topics,takeaways&status=eq.ready&created_at=gte." + weekStart.toISOString() + "&created_at=lte." + weekEnd.toISOString() + "&order=created_at.desc"),
    ]);

    const allItems = [
      ...(contentItems || []).map(i => ({ ...i, source_type: i.source_type || "article" })),
      ...(podcastItems || []).map(i => ({ ...i, source_type: "podcast", url: i.youtube_url || i.url })),
    ];

    if (allItems.length === 0) {
      return res.status(200).json({ digest: null, message: "No items saved this week" });
    }

    // Group by category
    const byCategory = {};
    for (const item of allItems) {
      const cat = item.category || "uncategorized";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(item);
    }

    // Build context for Claude
    const itemList = allItems.map(item =>
      `- "${item.title}" (${item.source_type}${item.channel ? ", " + item.channel : ""}, category: ${item.category || "uncategorized"})` +
      (item.summary ? `\n  Summary: ${item.summary.substring(0, 300)}` : "") +
      (item.takeaways?.length ? `\n  Takeaways: ${item.takeaways.slice(0, 3).join("; ")}` : "") +
      ((item.key_takeaways || []).length ? `\n  Takeaways: ${item.key_takeaways.slice(0, 3).join("; ")}` : "")
    ).join("\n\n");

    const prompt = `You are a personal knowledge assistant. Generate a weekly digest for the user's saved content. Be concise, insightful, and highlight patterns or themes across items.

Week: ${weekStartStr} to ${weekEndStr}
Total items saved: ${allItems.length}
Categories: ${Object.entries(byCategory).map(([k, v]) => k + " (" + v.length + ")").join(", ")}

Items saved this week:
${itemList}

Generate a JSON object with:
- "headline": A catchy 5-8 word headline summarizing the week's themes
- "overview": 2-3 paragraph narrative overview of what was saved, highlighting themes, patterns, and notable items. Write conversationally.
- "categories": Object mapping each category to a 1-2 sentence summary of what was saved in that category
- "highlights": Array of 3-5 most notable items with {"title": "...", "why": "1 sentence on why it stands out"}
- "stats": {"total": N, "articles": N, "podcasts": N, "top_category": "..."}

Return ONLY valid JSON, no markdown fences.`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) throw new Error("Claude API error: " + claudeRes.status);
    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || "";
    const jsonStr = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```$/, "").trim();
    const digestContent = JSON.parse(jsonStr);

    // Upsert digest into Supabase — try update first, then insert
    const existing = await supaFetch("kb_digests?week_start=eq." + weekStartStr + "&limit=1");
    if (existing && existing.length > 0) {
      await supaFetch("kb_digests?week_start=eq." + weekStartStr, {
        method: "PATCH",
        body: JSON.stringify({ content: digestContent }),
      });
    } else {
      await supaFetch("kb_digests", {
        method: "POST",
        body: JSON.stringify({ week_start: weekStartStr, week_end: weekEndStr, content: digestContent }),
      });
    }

    // Send email if requested or cron-triggered
    if ((sendEmail || isCron) && process.env.RESEND_API_KEY && process.env.DIGEST_EMAIL) {
      await sendDigestEmail(digestContent, weekStartStr, weekEndStr, allItems.length);
    }

    res.status(200).json({ digest: { week_start: weekStartStr, week_end: weekEndStr, content: digestContent } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function sendDigestEmail(content, weekStart, weekEnd, totalItems) {
  const categoriesHtml = Object.entries(content.categories || {}).map(([cat, summary]) =>
    `<li><strong>${cat}</strong>: ${summary}</li>`
  ).join("");

  const highlightsHtml = (content.highlights || []).map(h =>
    `<li><strong>${h.title}</strong> — ${h.why}</li>`
  ).join("");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
      <h1 style="font-size:20px;margin-bottom:4px">🧠 ${content.headline || "Weekly Knowledge Digest"}</h1>
      <p style="color:#666;font-size:13px;margin-top:0">Week of ${weekStart} — ${totalItems} items saved</p>
      <div style="line-height:1.6;font-size:14px;white-space:pre-wrap;margin:16px 0">${content.overview || ""}</div>
      ${categoriesHtml ? `<h3 style="font-size:15px">By Category</h3><ul style="font-size:14px;line-height:1.6">${categoriesHtml}</ul>` : ""}
      ${highlightsHtml ? `<h3 style="font-size:15px">Highlights</h3><ul style="font-size:14px;line-height:1.6">${highlightsHtml}</ul>` : ""}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
      <p style="color:#999;font-size:11px">Generated by PKE — Personal Knowledge Engine</p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.RESEND_API_KEY },
    body: JSON.stringify({
      from: "PKE Digest <onboarding@resend.dev>",
      to: process.env.DIGEST_EMAIL,
      subject: "🧠 " + (content.headline || "Your Weekly Knowledge Digest") + " — " + weekStart,
      html,
    }),
  });
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
