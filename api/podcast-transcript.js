export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "Missing youtubeUrl" });

  try {
    // 1. Fetch YouTube page
    const pageRes = await fetch(youtubeUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!pageRes.ok) throw new Error("Failed to fetch YouTube page: " + pageRes.status);
    const html = await pageRes.text();

    // 2. Extract ytInitialPlayerResponse
    const prMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*<\/script/s);
    if (!prMatch) throw new Error("Could not parse YouTube page — video may be unavailable");
    let playerResponse;
    try {
      playerResponse = JSON.parse(prMatch[1]);
    } catch {
      throw new Error("Could not parse YouTube player data");
    }

    // 3. Extract metadata
    const details = playerResponse.videoDetails || {};
    const title = details.title || "Unknown";
    const channel = details.author || "";
    const lengthSec = parseInt(details.lengthSeconds, 10);
    const duration = lengthSec
      ? (lengthSec >= 3600
          ? Math.floor(lengthSec / 3600) + "h " + Math.floor((lengthSec % 3600) / 60) + "m"
          : Math.floor(lengthSec / 60) + "m")
      : "";

    // 4. Find caption tracks
    const captions = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captions || captions.length === 0) {
      throw new Error("No captions available for this video");
    }

    // Prefer English, fall back to first
    const track =
      captions.find((t) => t.languageCode === "en") ||
      captions.find((t) => t.languageCode?.startsWith("en")) ||
      captions[0];

    // 5. Fetch caption XML
    const capRes = await fetch(track.baseUrl);
    if (!capRes.ok) throw new Error("Failed to fetch captions");
    const capXml = await capRes.text();

    // 6. Parse <text> elements
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
