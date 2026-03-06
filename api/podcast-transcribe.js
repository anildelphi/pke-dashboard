import ytdl from "@distube/ytdl-core";

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

    // Use ytdl-core to extract audio stream URL (handles YouTube's signature decryption)
    const info = await ytdl.getInfo(youtubeUrl);
    const audioFormats = ytdl
      .filterFormats(info.formats, "audioonly")
      .filter((f) => f.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (audioFormats.length === 0) {
      throw new Error("Could not access audio stream for this video. It may be restricted or unavailable.");
    }

    // Prefer mp4/aac for best compatibility with AssemblyAI
    const audioFormat =
      audioFormats.find((f) => f.mimeType && f.mimeType.startsWith("audio/mp4")) || audioFormats[0];

    // Submit audio URL to AssemblyAI for transcription
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
