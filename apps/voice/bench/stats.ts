// M7 Step 3: the benchmark's statistics (spec §12). Percentiles are nearest-rank; word error rate uses the spike's
// normalisation (docs/spikes/2026-11-09-voice-latency.md), so results compare with the spike's tables.

/** The nearest-rank percentile: the smallest value with at least p% of the values at or below it. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) throw new RangeError('percentile of no values');
  if (!(p > 0 && p <= 100)) throw new RangeError('percentile: p must be in (0, 100]');
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1];
}

/** The spike's normalisation: lowercased, hyphens to spaces ("K-I-W-I" → "k i w i"), "12" → "twelve", "2" → "two", other punctuation dropped. */
export function normaliseForWer(s: string): string {
  let t = s.toLowerCase().replace(/-/g, ' ').replace(/’/g, "'");
  t = t.replace(/\b2\b/g, 'two').replace(/\b12\b/g, 'twelve');
  t = t.replace(/[^a-z0-9' ]/g, ' ');
  return t.split(/\s+/).filter((w) => w !== '').join(' ');
}

function words(s: string): string[] {
  const n = normaliseForWer(s);
  return n === '' ? [] : n.split(' ');
}

/** Word-level edit distance (substitutions, insertions, deletions). */
function edits(ref: readonly string[], hyp: readonly string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[hyp.length];
}

/** Word error rate of one hypothesis against its reference. */
export function wer(ref: string, hyp: string): number {
  return corpusWer([[ref, hyp]]);
}

/** Corpus WER: all edits over all reference words, as jiwer computes it for a list (what the spike reported). */
export function corpusWer(pairs: readonly (readonly [string, string])[]): number {
  let e = 0;
  let n = 0;
  for (const [ref, hyp] of pairs) {
    const r = words(ref);
    e += edits(r, words(hyp));
    n += r.length;
  }
  if (n === 0) throw new RangeError('corpusWer: the references have no words');
  return e / n;
}

/** The share of hard terms in the references that the hypotheses contain as whole words (the spike's "terms"). */
export function termRecall(pairs: readonly (readonly [string, string])[], terms: readonly string[]): number {
  let hit = 0;
  let total = 0;
  for (const [ref, hyp] of pairs) {
    const r = new Set(words(ref));
    const h = new Set(words(hyp));
    for (const t of terms) {
      if (!r.has(t)) continue;
      total++;
      if (h.has(t)) hit++;
    }
  }
  return total === 0 ? 1 : hit / total;
}
