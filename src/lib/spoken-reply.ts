export const BRIEF_AUDIO_GUIDANCE = "This conversation prefers Brief audio. Provide a spoken_summary of 2–4 natural sentences (aim for 40–80 words; maximum 1200 characters) alongside your complete Markdown body. Keep code and raw URLs out of the summary. If your post_message tool has no spoken_summary argument, begin body with <spoken_summary>your summary</spoken_summary>, followed by the full Markdown answer. The board extracts that prefix. Do not omit the full answer.";

export function normalizeSpokenReply(body: string, spokenSummary?: string | null) {
  let fullBody = body.trim();
  let summary = spokenSummary?.trim() || null;
  const prefix = fullBody.match(/^<spoken_summary>\s*([\s\S]*?)\s*<\/spoken_summary>\s*([\s\S]*)$/);
  if (prefix) {
    summary ??= prefix[1].trim() || null;
    fullBody = prefix[2].trim();
  }
  if (!fullBody) throw new Error("A full written answer is required");
  if (summary && summary.length > 1200) throw new Error("Spoken summary must be 1200 characters or fewer");
  return { body: fullBody, spoken_summary: summary };
}
