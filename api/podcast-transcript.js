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

    // Fetch metadata and transcript in parallel
    const [meta, transcript] = await Promise.all([
      fetchMetadata(videoId),
      fetchTranscript(videoId, youtubeUrl),
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

// Try multiple approaches — Supadata handles cloud IP blocking, innertube works locally
async function fetchTranscript(videoId, youtubeUrl) {
  // Approach 1: Supadata API (works from cloud IPs, 100 free requests/month)
  if (process.env.SUPADATA_API_KEY) {
    try {
      const text = await fetchViaSupadata(youtubeUrl);
      if (text) return text;
    } catch {}
  }

  // Approach 2: Direct innertube API with Android client
  try {
    const tracks = await getTracksViaInnerTube(videoId, {
      name: "ANDROID",
      version: ANDROID_VERSION,
      ua: ANDROID_UA,
    });
    if (tracks) {
      const text = await fetchCaptionText(tracks);
      if (text) return text;
    }
  } catch {}

  // Approach 3: Innertube with WEB client identity
  try {
    const tracks = await getTracksViaInnerTube(videoId, {
      name: "WEB",
      version: "2.20240313.05.00",
      ua: BROWSER_UA,
    });
    if (tracks) {
      const text = await fetchCaptionText(tracks);
      if (text) return text;
    }
  } catch {}

  // Approach 4: Scrape YouTube web page
  try {
    const tracks = await getTracksViaWebPage(videoId);
    if (tracks) {
      const text = await fetchCaptionText(tracks);
      if (text) return text;
    }
  } catch {}

  return null;
}

async function fetchViaSupadata(youtubeUrl) {
  const res = await fetch(
    `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(youtubeUrl)}`,
    { headers: { "x-api-key": process.env.SUPADATA_API_KEY } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  // Supadata returns { content: [{ text, offset, duration, lang }] } or { content: "text" }
  if (typeof data.content === "string") return data.content;
  if (Array.isArray(data.content)) {
    return data.content
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim() || null;
  }
  return null;
}

async function getTracksViaInnerTube(videoId, client) {
  const res = await fetch(INNERTUBE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": client.ua },
    body: JSON.stringify({
      context: { client: { clientName: client.name, clientVersion: client.version } },
      videoId,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) && tracks.length > 0 ? tracks : null;
}

async function getTracksViaWebPage(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
      Cookie: "CONSENT=PENDING+987; SOCS=CAISEwgDEgk2MjczNDE5NjQaAmVuIAEaBgiA_LyuBg",
    },
  });
  if (!res.ok) return null;
  const html = await res.text();

  const marker = "var ytInitialPlayerResponse = ";
  const start = html.indexOf(marker);
  if (start === -1) return null;

  const jsonStart = start + marker.length;
  let depth = 0;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          const data = JSON.parse(html.slice(jsonStart, i + 1));
          const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          return Array.isArray(tracks) && tracks.length > 0 ? tracks : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchCaptionText(tracks) {
  const track =
    tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ||
    tracks.find((t) => t.languageCode === "en") ||
    tracks.find((t) => t.languageCode?.startsWith("en")) ||
    tracks[0];

  const res = await fetch(track.baseUrl, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" },
  });
  if (!res.ok) return null;
  const xml = await res.text();
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

  return (
    textSegments
      .map((m) => decodeEntities(m[1]).replace(/\n/g, " ").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
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
    const oembedRes = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    if (!oembedRes.ok) throw new Error("oEmbed failed");
    const oembed = await oembedRes.json();

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
