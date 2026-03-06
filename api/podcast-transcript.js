export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "Missing youtubeUrl" });

  try {
    // 1. Extract video ID from URL
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) throw new Error("Could not extract video ID from URL");

    // 2. Use YouTube innertube API to get player data (much more reliable than page scraping)
    const playerRes = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: videoId,
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20250220.01.00",
            hl: "en",
          },
        },
      }),
    });
    if (!playerRes.ok) throw new Error("YouTube API error: " + playerRes.status);
    const playerData = await playerRes.json();

    // 3. Extract metadata
    const details = playerData.videoDetails || {};
    const title = details.title || "Unknown";
    const channel = details.author || "";
    const lengthSec = parseInt(details.lengthSeconds, 10);
    const duration = lengthSec
      ? lengthSec >= 3600
        ? Math.floor(lengthSec / 3600) + "h " + Math.floor((lengthSec % 3600) / 60) + "m"
        : Math.floor(lengthSec / 60) + "m"
      : "";

    // 4. Find caption tracks
    const captions = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captions || captions.length === 0) {
      // Return metadata with noCaptions flag so frontend can fall back to AssemblyAI
      return res.status(200).json({ transcript: null, noCaptions: true, title, channel, duration });
    }

    // Prefer English, fall back to first available
    const track =
      captions.find((t) => t.languageCode === "en") ||
      captions.find((t) => t.languageCode?.startsWith("en")) ||
      captions[0];

    // 5. Fetch caption XML
    const capRes = await fetch(track.baseUrl);
    if (!capRes.ok) throw new Error("Failed to fetch captions");
    const capXml = await capRes.text();

    // 6. Parse <text> elements into plain text
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

    if (!transcript) throw new Error("Transcript is empty");

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
