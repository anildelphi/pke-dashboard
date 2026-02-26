export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const { transcript, title } = req.body;
  if (!transcript) return res.status(400).json({ error: "Missing transcript" });

  // Truncate long transcripts to keep Claude response fast
  const MAX_CHARS = 60000;
  const truncated = transcript.length > MAX_CHARS;
  const text = truncated ? transcript.slice(0, MAX_CHARS) : transcript;

  const prompt = `Analyze this podcast transcript and return a JSON object with exactly these fields:

- "summary": A detailed multi-paragraph summary (3-5 paragraphs) covering the key discussion points, arguments, and conclusions
- "quotes": Array of 5-10 important verbatim quotes from the transcript (use the exact wording from the transcript)
- "people": Array of objects {"name": "...", "context": "..."} for notable people, companies, or organizations mentioned, with brief context about why they were discussed
- "content_references": Array of objects {"title": "...", "type": "book|paper|article|podcast|video|tool", "author": "..."} for books, papers, tools, or content referenced in the discussion
- "topics": Array of 5-10 key topic or theme strings
- "takeaways": Array of 5-10 actionable takeaway strings — things the listener should remember or act on

Podcast title: ${title}
${truncated ? "(Note: transcript was truncated to first ~60,000 characters)" : ""}

Transcript:
${text}

Return ONLY valid JSON. No markdown code fences, no explanation, just the JSON object.`;

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error("Claude API error: " + claudeRes.status + " " + errText);
    }

    const claudeData = await claudeRes.json();
    const content = claudeData.content?.[0]?.text || "";

    // Parse JSON from response (strip markdown fences if present)
    const jsonStr = content
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?\s*```$/, "")
      .trim();

    let analysis;
    try {
      analysis = JSON.parse(jsonStr);
    } catch {
      throw new Error("Claude returned invalid JSON format");
    }

    res.status(200).json(analysis);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
