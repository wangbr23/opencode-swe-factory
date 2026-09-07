export function extractTerms(text: string): Set<string> {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const terms = new Set<string>();
  for (const token of tokens) {
    terms.add(token.toLowerCase());
  }
  return terms;
}

export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const term of smaller) {
    if (larger.has(term)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}
