/** Levenshtein distance and fuzzy matching for template name suggestions. */

/**
 * Computes the Levenshtein edit distance between two strings.
 * Uses the standard dynamic programming approach with O(min(a,b)) space.
 * Reference-swaps the row buffers each iteration to avoid O(n) array allocations.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const aLen = a.length;
  const bLen = b.length;
  let prev = Array.from({ length: aLen + 1 }, (_, i) => i);
  let curr = Array.from({ length: aLen + 1 }, () => 0);

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        (curr[i - 1] ?? 0) + 1, // insertion
        (prev[i] ?? 0) + 1, // deletion
        (prev[i - 1] ?? 0) + cost, // substitution
      );
    }
    // Swap references instead of copying — O(1) per iteration, true O(n) total space
    [prev, curr] = [curr, prev];
  }

  return prev[aLen] ?? 0;
}

/** Maximum edit distance to consider a "close" match (relative to input length). */
const MAX_DISTANCE_RATIO = 0.6;

/**
 * Finds the closest match for a query among candidates using Levenshtein distance.
 * Returns the best match if within the distance threshold, or null if no close match.
 * Threshold: edit distance must be <= 60% of the longer of (query, candidate) lengths,
 * minimum 2. Using the longer string prevents short prefix queries (e.g. "fix") from
 * being unable to match long canonical names (e.g. "fix-bugs").
 */
export function findClosestMatch(query: string, candidates: readonly string[]): string | null {
  if (candidates.length === 0) return null;

  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  const lowerQuery = query.toLowerCase();
  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();
    const maxDistance = Math.max(
      2,
      Math.floor(Math.max(query.length, candidate.length) * MAX_DISTANCE_RATIO),
    );
    const dist = levenshteinDistance(lowerQuery, lowerCandidate);
    if (dist < bestDistance && dist <= maxDistance) {
      bestDistance = dist;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}
