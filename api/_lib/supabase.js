const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

export async function supaFetch(path, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Supabase credentials not configured");
  }
  const { headers: extraHeaders, ...restOpts } = opts;
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...restOpts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
  if (!res.ok) throw new Error("Supabase error: " + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
