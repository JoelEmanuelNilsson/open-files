import path from "path";

/** A fsearch match with its modification time; `fsearchRank` is its 0-based position in the merged, score-ordered hits. */
export type FuzzyMatchCandidate = {
  readonly path: string;
  readonly fsearchRank: number;
  readonly mtimeMs: number;
};

/** A fuzzy match after recency ranking, with its modification time for display. */
export type RankedFuzzyMatch = {
  readonly path: string;
  readonly mtimeMs: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_HALF_LIFE_DAYS = 7;
const RECENCY_WEIGHT = 1.5;
// fsearch's own order is the match-quality signal within a tier; the bonus halves by rank 20 so only its top picks count.
const FSEARCH_RANK_WEIGHT = 1;
const FSEARCH_RANK_HALF_POINT = 20;
// Recency plus fsearch rank add at most 2.5, which never lifts a scattered match (e.g. m/o/t/i/o/n) over a name match.
const NAME_MATCH_TIER = 3;
const PATH_MATCH_TIER = 1.5;
const SCATTERED_MATCH_TIER = 0;

function scoreMatchTier(filepath: string, terms: ReadonlyArray<string>): number {
  const lowerPath = filepath.toLowerCase();
  const name = path.basename(lowerPath);
  if (terms.length === 0 || !terms.every((term) => lowerPath.includes(term))) {
    return SCATTERED_MATCH_TIER;
  }
  return terms.some((term) => name.includes(term)) ? NAME_MATCH_TIER : PATH_MATCH_TIER;
}

/**
 * Re-ranks fsearch matches so recent files come first among reasonable matches: score = match tier
 * (terms in file name > query in path > scattered letters) + recency with a 7-day half-life + fsearch rank bonus.
 */
export function rankFuzzyMatchesByRecency(
  candidates: ReadonlyArray<FuzzyMatchCandidate>,
  terms: ReadonlyArray<string>,
  nowMs: number,
): RankedFuzzyMatch[] {
  return candidates
    .map((candidate) => {
      const ageDays = Math.max(nowMs - candidate.mtimeMs, 0) / DAY_MS;
      const score =
        scoreMatchTier(candidate.path, terms) +
        RECENCY_WEIGHT * 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS) +
        FSEARCH_RANK_WEIGHT / (1 + candidate.fsearchRank / FSEARCH_RANK_HALF_POINT);
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score || a.candidate.fsearchRank - b.candidate.fsearchRank)
    .map(({ candidate }) => ({ path: candidate.path, mtimeMs: candidate.mtimeMs }));
}
