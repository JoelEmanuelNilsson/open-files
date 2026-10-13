import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchQuery } from "./parse-search-query.ts";
import { rankFuzzyMatchesByRecency } from "./rank-fuzzy-matches.ts";

const now = Date.UTC(2026, 8, 24, 12);
const hoursAgo = (hours: number) => now - hours * 60 * 60 * 1000;
const daysAgo = (days: number) => hoursAgo(days * 24);

function rankPaths(entries: ReadonlyArray<{ path: string; mtimeMs: number }>, terms: string[]): string[] {
  const candidates = entries.map((entry, fsearchRank) => ({ ...entry, fsearchRank }));
  return rankFuzzyMatchesByRecency(candidates, terms, now).map((match) => match.path);
}

test("an old exact name match beats a fresh scattered match even when fsearch ranked it first", () => {
  const ranked = rankPaths(
    [
      { path: "/tmp/m/o/t/i/o/n.txt", mtimeMs: hoursAgo(0) },
      { path: "/Users/joel/Code/motion", mtimeMs: daysAgo(365) },
    ],
    ["motion"],
  );
  assert.deepEqual(ranked, ["/Users/joel/Code/motion", "/tmp/m/o/t/i/o/n.txt"]);
});

test("fsearch's top pick wins among equally fresh name matches", () => {
  const ranked = rankFuzzyMatchesByRecency(
    [
      { path: "/tmp/dw/motion_both.png", fsearchRank: 2, mtimeMs: hoursAgo(0.4) },
      { path: "/tmp/dry/repo/public/css/frames/2/motion.css", fsearchRank: 115, mtimeMs: hoursAgo(0.1) },
    ],
    ["motion"],
    now,
  );
  assert.deepEqual(
    ranked.map((match) => match.path),
    ["/tmp/dw/motion_both.png", "/tmp/dry/repo/public/css/frames/2/motion.css"],
  );
});

test("a fresh name match beats an old exact name match fsearch ranked first", () => {
  const ranked = rankPaths(
    [
      { path: "/Users/joel/Code/motion", mtimeMs: daysAgo(90) },
      { path: "/tmp/dw/motion_both.png", mtimeMs: hoursAgo(1) },
    ],
    ["motion"],
  );
  assert.deepEqual(ranked, ["/tmp/dw/motion_both.png", "/Users/joel/Code/motion"]);
});

test("equal matches rank newer first even when fsearch ranked the older one higher", () => {
  const ranked = rankPaths(
    [
      { path: "/Users/joel/a/motion_old.png", mtimeMs: daysAgo(30) },
      { path: "/Users/joel/b/motion_new.png", mtimeMs: hoursAgo(3) },
    ],
    ["motion"],
  );
  assert.deepEqual(ranked, ["/Users/joel/b/motion_new.png", "/Users/joel/a/motion_old.png"]);
});

test("equal matches with equal age keep fsearch order", () => {
  const ranked = rankPaths(
    [
      { path: "/a/motion_1.png", mtimeMs: daysAgo(2) },
      { path: "/b/motion_2.png", mtimeMs: daysAgo(2) },
    ],
    ["motion"],
  );
  assert.deepEqual(ranked, ["/a/motion_1.png", "/b/motion_2.png"]);
});

test("ranking uses the parsed literal terms only: filters and anchors are not terms", () => {
  const entries = [
    { path: "/a/other.pdf", mtimeMs: hoursAgo(1) },
    { path: "/b/report.pdf", mtimeMs: daysAgo(30) },
  ];
  const rankedFor = (text: string) => rankPaths(entries, parseSearchQuery(text, "/Users/joel").terms);
  assert.deepEqual(rankedFor("ext:pdf report"), ["/b/report.pdf", "/a/other.pdf"]);
  assert.deepEqual(
    rankPaths(
      [
        { path: "/x/foo.md", mtimeMs: daysAgo(30) },
        { path: "/y/bar.md", mtimeMs: hoursAgo(1) },
      ],
      parseSearchQuery("foo$", "/h").terms,
    ),
    ["/x/foo.md", "/y/bar.md"],
  );
});
