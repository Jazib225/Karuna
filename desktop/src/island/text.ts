// Text shown in the voice panel. No dependencies: tested on its own (text.test.ts).

/** Zero-width spaces and joiners, and the byte-order mark: never shown. */
const INVISIBLE = new RegExp(`[${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d)}${String.fromCharCode(0xfeff)}]`, "g");
/** What's shown in the transcript: words only. The voice's pause tags (<break time="0.6s" />) are
 *  heard, not shown; any other markup, a tag cut off mid-stream, escaped tags and invisible
 *  characters go too, so a line always reads cleanly. */
export const cleanSpoken = (t: string) =>
  t
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(INVISIBLE, "")
    .replace(/<\/?[a-z][^>]*>/gi, " ") // whole tags
    .replace(/<\s*break\b[^<]*$/i, " ") // a pause tag cut off at the end
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
