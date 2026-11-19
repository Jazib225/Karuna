// Does what the offline recognizer heard contain the member's wake phrase?
//
// The small offline model only knows common English words, so a name like "Karuna" comes out as
// "corona", "car una" or "karina". So this compares how the words SOUND, not how they're spelled:
// each candidate stretch of what was heard is reduced to its consonant skeleton ("hey karuna" ->
// "hkrn") and compared to the phrase's, with a little room for one misheard sound, plus a looser
// check on the letters themselves. No dependencies: tested on its own (wake-match.test.ts).

/** Lowercase words, letters and digits only. */
export function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/'/g, "").split(/\s+/).filter(Boolean);
}

/** How a word sounds, roughly: consonants only, similar sounds merged, doubles collapsed. */
export function skeleton(text: string): string {
  let s = text.toLowerCase().replace(/[^a-z]/g, "");
  s = s
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/qu/g, "kw")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/dg/g, "j")
    .replace(/gh/g, "")
    .replace(/[aeiouyhw]/g, (ch, i: number) => (i === 0 && ch === "h" ? "h" : "")) // keep a leading h ("hey")
    .replace(/(.)\1+/g, "$1");
  return s;
}

/** Edit distance (insert, delete, replace), small strings only. */
export function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** True when `heard` contains something that sounds like `phrase`. */
export function heardPhrase(phrase: string, heard: string): boolean {
  const P = words(phrase);
  const H = words(heard);
  if (!P.length || !H.length) return false;
  const target = P.join("");
  const targetSk = P.map(skeleton).join("");
  if (` ${H.join(" ")} `.includes(` ${P.join(" ")} `)) return true; // heard exactly
  if (target.length < 3) return false; // too short to match loosely without false alarms
  const skRoom = Math.max(1, Math.floor(targetSk.length * 0.25));
  const letterRoom = Math.ceil(target.length * 0.4);
  // Every stretch of heard words of about the phrase's length (a word may be split or merged).
  for (let n = Math.max(1, P.length - 1); n <= P.length + 2; n++) {
    for (let i = 0; i + n <= H.length; i++) {
      const win = H.slice(i, i + n);
      const letters = win.join("");
      if (Math.abs(letters.length - target.length) > letterRoom) continue;
      const sk = win.map(skeleton).join("");
      if (!sk || Math.abs(sk.length - targetSk.length) > skRoom) continue;
      // The first and last sounds must match: "compute" isn't "computer", but "corona" is "karuna".
      if (sk[0] !== targetSk[0] || sk[sk.length - 1] !== targetSk[targetSk.length - 1]) continue;
      if (distance(sk, targetSk) <= skRoom && distance(letters, target) <= letterRoom) return true;
    }
  }
  return false;
}
