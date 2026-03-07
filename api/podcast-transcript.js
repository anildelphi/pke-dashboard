export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "Missing youtubeUrl" });

  try {
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) throw new Error("Could not extract video ID from URL");

    // Fetch the YouTube watch page HTML — more reliable than innertube API
    // because YouTube serves full page data even to server IPs
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
        Cookie: "CONSENT=PENDING+987; SOCS=CAISEwgDEgk2MjczNDE5NjQaAmVuIAEaBgiA_LyuBg",
      },
    });
    if (!pageRes.ok) throw new Error("Failed to fetch YouTube page: " + pageRes.status);
    const html = await pageRes.text();

    // Extract ytInitialPlayerResponse from page HTML
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.*?});\s*(?:var |<\/script)/s);
    if (!playerMatch) throw new Error("Could not extract player data from YouTube page");
    const playerData = JSON.parse(playerMatch[1]);

    // Extract metadata
    const details = playerData.videoDetails || {};
    const title = details.title || "Unknown";
    const channel = details.author || "";
    const lengthSec = parseInt(details.lengthSeconds, 10);
    const duration = lengthSec
      ? lengthSec >= 3600
        ? Math.floor(lengthSec / 3600) + "h " + Math.floor((lengthSec % 3600) / 60) + "m"
        : Math.floor(lengthSec / 60) + "m"
      : "";

    // Find caption tracks
    const captions = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captions || captions.length === 0) {
      return res.status(200).json({ transcript: null, noCaptions: true, title, channel, duration });
    }

    // Prefer English manual captions, then English auto-generated, then first available
    const track =
      captions.find((t) => t.languageCode === "en" && t.kind !== "asr") ||
      captions.find((t) => t.languageCode === "en") ||
      captions.find((t) => t.languageCode?.startsWith("en")) ||
      captions[0];

    // Forward cookies from the page response for session continuity
    const setCookies = pageRes.headers.getSetCookie?.() || [];
    const cookieStr = setCookies.map((c) => c.split(";")[0]).join("; ");

    // Fetch caption XML
    const capRes = await fetch(track.baseUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: `https://www.youtube.com/watch?v=${videoId}`,
        Accept: "*/*",
        ...(cookieStr ? { Cookie: cookieStr } : {}),
      },
    });
    if (!capRes.ok) throw new Error("Failed to fetch captions: " + capRes.status);
    const capXml = await capRes.text();

    // If caption content is empty (YouTube sometimes blocks this), fall back to AssemblyAI
    if (!capXml || !capXml.includes("<text")) {
      return res.status(200).json({ transcript: null, noCaptions: true, title, channel, duration });
    }

    // Parse <text> elements into plain text
    const texts = [...capXml.matchAll(/<text[^>]*>(.*?)<\/text>/gs)].map((m) =>
      m[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n/g, " ")
    );
    const transcript = texts.join(" ").replace(/\s+/g, " ").trim();

    if (!transcript) {
      return res.status(200).json({ transcript: null, noCaptions: true, title, channel, duration });
    }

    res.status(200).json({ transcript, title, channel, duration });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

function extractVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}
