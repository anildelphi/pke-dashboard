const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const ANDROID_VERSION = "20.10.38";
const ANDROID_UA = `com.google.android.youtube/${ANDROID_VERSION} (Linux; U; Android 14)`;
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { youtubeUrl } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "Missing youtubeUrl" });

  try {
    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) throw new Error("Could not extract video ID from URL");

    // Fetch metadata via oEmbed (reliable from any IP) and transcript via innertube Android API
    const [meta, transcript] = await Promise.all([
      fetchMetadata(videoId),
      fetchTranscriptViaInnerTube(videoId),
    ]);

    const { title, channel, duration } = meta;

    if (!transcript) {
      return res.status(200).json({ transcript: null, noCaptions: true, title, channel, duration });
    }

    res.status(200).json({ transcript, title, channel, duration });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Use YouTube's innertube Android API to get caption tracks, then fetch captions directly
// This is the same approach used by youtube-transcript-api and youtube-transcript npm packages
async function fetchTranscriptViaInnerTube(videoId) {
  // Step 1: Call innertube player API with Android client to get caption track URLs
  const playerRes = await fetch(INNERTUBE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
    body: JSON.stringify({
      context: { client: { clientName: "ANDROID", clientVersion: ANDROID_VERSION } },
      videoId,
    }),
  });
  if (!playerRes.ok) return null;

  const data = await playerRes.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;

  // Prefer English manual captions, then English auto-generated, then first available
  const track =
    tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ||
    tracks.find((t) => t.languageCode === "en") ||
    tracks.find((t) => t.languageCode?.startsWith("en")) ||
    tracks[0];

  // Step 2: Fetch caption content from the track URL
  const capRes = await fetch(track.baseUrl, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" },
  });
  if (!capRes.ok) return null;
  const xml = await capRes.text();

  // Step 3: Parse — try new <p>/<s> format first, fall back to legacy <text> format
  return parseTranscriptXml(xml);
}

function parseTranscriptXml(xml) {
  // New format: <p t="offset" d="duration"><s>word</s>...</p>
  const pSegments = [...xml.matchAll(/<p\s+t="\d+"\s+d="\d+"[^>]*>([\s\S]*?)<\/p>/g)];
  if (pSegments.length > 0) {
    const texts = pSegments.map((m) => {
      const inner = m[1];
      const words = [...inner.matchAll(/<s[^>]*>([^<]*)<\/s>/g)].map((w) => w[1]);
      const text = words.length > 0 ? words.join("") : inner.replace(/<[^>]+>/g, "");
      return decodeEntities(text).trim();
    });
    const result = texts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (result) return result;
  }

  // Legacy format: <text start="..." dur="...">content</text>
  const textSegments = [...xml.matchAll(/<text[^>]*>(.*?)<\/text>/gs)];
  if (textSegments.length === 0) return null;

  const result = textSegments
    .map((m) => decodeEntities(m[1]).replace(/\n/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return result || null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

async function fetchMetadata(videoId) {
  try {
    // oEmbed for title/channel — works from any IP, no auth needed
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (!oembedRes.ok) throw new Error("oEmbed failed");
    const oembed = await oembedRes.json();

    // Innertube for duration
    let duration = "";
    try {
      const playerRes = await fetch(INNERTUBE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": ANDROID_UA },
        body: JSON.stringify({
          context: { client: { clientName: "ANDROID", clientVersion: ANDROID_VERSION } },
          videoId,
        }),
      });
      if (playerRes.ok) {
        const data = await playerRes.json();
        const lengthSec = parseInt(data.videoDetails?.lengthSeconds, 10);
        if (lengthSec) {
          duration =
            lengthSec >= 3600
              ? Math.floor(lengthSec / 3600) + "h " + Math.floor((lengthSec % 3600) / 60) + "m"
              : Math.floor(lengthSec / 60) + "m";
        }
      }
    } catch {}

    return { title: oembed.title || "Unknown", channel: oembed.author_name || "", duration };
  } catch {
    return { title: "Unknown", channel: "", duration: "" };
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
