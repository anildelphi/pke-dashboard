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
      await sendDigestEmail(digestContent, weekStartStr, weekEndStr, allItems);
    }

    res.status(200).json({ digest: { week_start: weekStartStr, week_end: weekEndStr, content: digestContent } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

const CAT_COLORS = {
  ai: "#a78bfa", crypto: "#fbbf24", investing: "#34d399", health: "#f87171",
  personal: "#fb923c", delphi: "#60a5fa", media: "#e879f9", music: "#f472b6",
  culture: "#c084fc", tech: "#22d3ee", geopolitics: "#fb7185", uncategorized: "#6b7280",
};
const CAT_LABELS = {
  ai: "AI", crypto: "Crypto", investing: "Investing", health: "Health",
  personal: "Personal", delphi: "Delphi", media: "Media", music: "Music",
  culture: "Culture", tech: "Tech", geopolitics: "Geopolitics", uncategorized: "Uncategorized",
};
const TYPE_ICONS = {
  article: "📄", podcast: "🎙️", video: "🎬", paper: "📑",
  book: "📚", note: "📝", tweet: "🐦", thread: "🧵",
};

async function sendDigestEmail(content, weekStart, weekEnd, items) {
  const totalItems = items.length;

  // Highlights section
  const highlightsHtml = (content.highlights || []).map(h =>
    `<tr><td style="padding:6px 0;font-size:14px;border-bottom:1px solid #f0f0f0">
      <strong>${esc(h.title)}</strong><br/>
      <span style="color:#666;font-size:13px">${esc(h.why)}</span>
    </td></tr>`
  ).join("");

  // Group items by category, sorted by count desc
  const grouped = {};
  for (const item of items) {
    const cat = item.category || "uncategorized";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }
  const sortedCats = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length);

  // Build itemized breakdown HTML
  const breakdownHtml = sortedCats.map(([cat, catItems]) => {
    const color = CAT_COLORS[cat] || "#6b7280";
    const label = CAT_LABELS[cat] || cat;
    const itemRows = catItems.map(item => {
      const icon = TYPE_ICONS[item.source_type] || "📄";
      const title = esc(item.title || "Untitled");
      const link = item.url ? `<a href="${esc(item.url)}" style="color:#1a1a1a;text-decoration:none;font-weight:500">${title}</a>` : title;
      const summary = item.summary ? `<br/><span style="color:#888;font-size:12px">${esc(truncate(item.summary, 120))}</span>` : "";
      return `<tr><td style="padding:5px 0 5px 8px;font-size:13px;border-bottom:1px solid #f8f8f8">
        ${icon} ${link}${summary}
      </td></tr>`;
    }).join("");

    return `
      <div style="margin-bottom:20px">
        <div style="display:inline-block;background:${color};color:#fff;font-size:12px;font-weight:600;padding:3px 10px;border-radius:4px;margin-bottom:6px">
          ${label} (${catItems.length})
        </div>
        <table style="width:100%;border-collapse:collapse">${itemRows}</table>
      </div>`;
  }).join("");

  // Stats line
  const articles = items.filter(i => i.source_type === "article").length;
  const podcasts = items.filter(i => i.source_type === "podcast").length;
  const videos = items.filter(i => i.source_type === "video").length;
  const statParts = [`${totalItems} items`];
  if (articles) statParts.push(`${articles} articles`);
  if (podcasts) statParts.push(`${podcasts} podcasts`);
  if (videos) statParts.push(`${videos} videos`);
  const statsLine = statParts.join(" · ");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;padding:20px">
      <h1 style="font-size:22px;margin-bottom:4px;font-weight:700">🧠 ${esc(content.headline || "Weekly Knowledge Digest")}</h1>
      <p style="color:#666;font-size:13px;margin-top:0">Week of ${weekStart} to ${weekEnd} · ${statsLine}</p>

      <div style="background:#f9fafb;border-radius:8px;padding:16px;margin:20px 0">
        <h3 style="font-size:14px;margin:0 0 8px;color:#374151;text-transform:uppercase;letter-spacing:0.5px">Weekly Overview</h3>
        <div style="line-height:1.6;font-size:14px;color:#374151;white-space:pre-wrap">${esc(content.overview || "")}</div>
      </div>

      ${highlightsHtml ? `
      <div style="margin:20px 0">
        <h3 style="font-size:14px;margin:0 0 8px;color:#374151;text-transform:uppercase;letter-spacing:0.5px">⭐ Highlights</h3>
        <table style="width:100%;border-collapse:collapse">${highlightsHtml}</table>
      </div>` : ""}

      <div style="margin:24px 0">
        <h3 style="font-size:14px;margin:0 0 14px;color:#374151;text-transform:uppercase;letter-spacing:0.5px">📋 Everything You Saved</h3>
        ${breakdownHtml}
      </div>

      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />
      <p style="color:#9ca3af;font-size:11px;text-align:center">Generated by PKE — Personal Knowledge Engine</p>
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

function esc(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.substring(0, max).replace(/\s+\S*$/, "") + "…";
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
