export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ASSEMBLYAI_API_KEY not configured" });

  const { youtubeUrl, transcriptId } = req.body;

  try {
    // Mode 2: Poll for existing transcription status
    if (transcriptId) {
      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { Authorization: apiKey },
      });
      if (!pollRes.ok) throw new Error("AssemblyAI poll error: " + pollRes.status);
      const pollData = await pollRes.json();

      if (pollData.status === "completed") {
        return res.status(200).json({
          transcriptId,
          status: "completed",
          transcript: pollData.text,
        });
      } else if (pollData.status === "error") {
        return res.status(200).json({
          transcriptId,
          status: "error",
          error: pollData.error || "Transcription failed",
        });
      } else {
        return res.status(200).json({
          transcriptId,
          status: "processing",
        });
      }
    }

    // Mode 1: Submit new transcription
    if (!youtubeUrl) return res.status(400).json({ error: "Missing youtubeUrl or transcriptId" });

    const videoId = extractVideoId(youtubeUrl);
    if (!videoId) throw new Error("Could not extract video ID from URL");

    // Use ANDROID client to get direct (non-cipher) audio stream URLs
    const playerRes = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "19.09.37",
            androidSdkVersion: 30,
            hl: "en",
          },
        },
      }),
    });
    if (!playerRes.ok) throw new Error("YouTube API error: " + playerRes.status);
    const playerData = await playerRes.json();

    // Extract audio stream URL from adaptive formats
    const formats = playerData.streamingData?.adaptiveFormats || [];
    const audioFormats = formats
      .filter((f) => f.mimeType && f.mimeType.startsWith("audio/") && f.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (audioFormats.length === 0) {
      throw new Error("Could not access audio stream for this video. It may be restricted or unavailable.");
    }

    // Prefer audio/mp4 (AAC) for best compatibility, fall back to any
    const audioFormat =
      audioFormats.find((f) => f.mimeType.startsWith("audio/mp4")) || audioFormats[0];

    // Submit to AssemblyAI
    const aaiRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ audio_url: audioFormat.url }),
    });
    if (!aaiRes.ok) {
      const errText = await aaiRes.text();
      throw new Error("AssemblyAI submission error: " + aaiRes.status + " " + errText);
    }
    const aaiData = await aaiRes.json();

    res.status(200).json({
      transcriptId: aaiData.id,
      status: aaiData.status || "queued",
    });
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
