export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { spotifyUrl } = req.body;
  if (!spotifyUrl) return res.status(400).json({ error: "Missing spotifyUrl" });

  try {
    // 1. Get episode title from Spotify oEmbed
    const oembedRes = await fetch(
      "https://open.spotify.com/oembed?url=" + encodeURIComponent(spotifyUrl)
    );
    if (!oembedRes.ok) throw new Error("Could not fetch Spotify episode info");
    const oembed = await oembedRes.json();
    const spotifyTitle = oembed.title; // e.g. "Episode Name - Podcast Name"

    if (!spotifyTitle) throw new Error("Could not get episode title from Spotify");

    // 2. Search YouTube for the episode
    const searchQuery = encodeURIComponent(spotifyTitle + " full episode");
    const searchRes = await fetch(
      "https://www.youtube.com/results?search_query=" + searchQuery,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      }
    );
    if (!searchRes.ok) throw new Error("YouTube search failed");
    const searchHtml = await searchRes.text();

    // 3. Parse ytInitialData from search results
    const match = searchHtml.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script/s);
    if (!match) throw new Error("Could not parse YouTube search results");

    let data;
    try {
      data = JSON.parse(match[1]);
    } catch {
      throw new Error("Could not parse YouTube search data");
    }

    // 4. Find first video result
    const contents =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const video = contents.find((c) => c.videoRenderer);
    if (!video) throw new Error("No YouTube match found for this Spotify episode");

    const videoId = video.videoRenderer.videoId;
    const youtubeUrl = "https://www.youtube.com/watch?v=" + videoId;

    res.status(200).json({ youtubeUrl, spotifyTitle });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
