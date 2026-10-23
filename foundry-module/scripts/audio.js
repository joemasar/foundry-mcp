// Finding playlists and tracks by a loose name ("tavern music", "battle drums"). No Foundry globals,
// so it can be tested in Node.

// Words that say what kind of thing is wanted but not which one.
const GENERIC = new Set(["music", "song", "songs", "sound", "sounds", "track", "tracks", "playlist", "playlists", "audio", "the", "a", "an", "of", "some", "play"]);

export function words(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// The words that matter in a query. If every word is generic ("music"), keep them all.
export function keyWords(query) {
  const all = words(query);
  const key = all.filter((w) => !GENERIC.has(w));
  return key.length ? key : all;
}

// How well a name fits a query, from 0 (no match) up. Exact beats prefix beats most words found.
// A word counts if a name word starts with it ("drum" finds "Drums").
export function nameScore(name, query) {
  const n = String(name ?? "").toLowerCase().trim();
  const q = String(query ?? "").toLowerCase().trim();
  if (!n || !q) return 0;
  if (n === q) return 100;
  const key = keyWords(q);
  const nameWords = words(n);
  const found = key.filter((k) => nameWords.some((w) => w.startsWith(k) || (k.length > 3 && k.startsWith(w) && w.length > 3)));
  if (!found.length) return 0;
  let score = (found.length / key.length) * 50;
  if (n.startsWith(q)) score += 20;
  if (found.length === key.length) score += 10;
  // Shorter names win ties: "Battle" over "Battle at the Old Mill".
  return score - Math.min(9, nameWords.length);
}

// items: [{ name, ...}]. extraText(item) can add text that also counts, at half weight (a track's
// playlist name, say). Returns matches best first.
export function rankByName(items, query, extraText) {
  const out = [];
  for (const item of items) {
    let score = nameScore(item.name, query);
    if (extraText) {
      const extra = nameScore(`${extraText(item)} ${item.name}`, query) / 2;
      score = Math.max(score, extra);
    }
    if (score > 0) out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score || String(a.item.name).length - String(b.item.name).length).map((x) => x.item);
}

// Foundry's volume sliders are on a curve (AudioHelper.inputToVolume): slider position 0-1 to the
// stored volume, so "half volume" sounds like the slider at half.
export function volumeFromSlider(slider) {
  const v = Math.min(1, Math.max(0, Number(slider) || 0));
  return Math.round(v ** 1.5 * 1000) / 1000;
}
