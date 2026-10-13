import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FSEARCH_SOCKET, mergeFsearchHits, searchFsearch } from "./fsearch.ts";

test("the live daemon finds the dotfiles directory", { skip: !fs.existsSync(FSEARCH_SOCKET) }, async () => {
  const outcome = await searchFsearch([`kind:dir in:~ dotfiles`], 50);
  assert.equal(outcome.kind, "hits");
  if (outcome.kind === "hits") {
    assert.ok(outcome.hits.some((hit) => hit.path === path.join(os.homedir(), "dotfiles")));
  }
});

test("a search with no queries returns no hits without opening a socket", async () => {
  assert.deepEqual(await searchFsearch([], 50), { kind: "hits", hits: [] });
});

const hit = (path: string, score: number, mtime = 0) => ({ kind: "file" as const, path, score, mtime });

test("mergeFsearchHits orders by score across queries and keeps the highest-scored hit of a duplicate path", () => {
  const merged = mergeFsearchHits(
    [
      [hit("/a/low.md", 10), hit("/a/shared.md", 20)],
      [hit("/b/top.md", 90), hit("/a/shared.md", 50)],
    ],
    10,
  );
  assert.deepEqual(merged, [hit("/b/top.md", 90), hit("/a/shared.md", 50), hit("/a/low.md", 10)]);
});

test("mergeFsearchHits keeps only the best hits up to the limit", () => {
  const merged = mergeFsearchHits([[hit("/a", 1), hit("/b", 3)], [hit("/c", 2)]], 2);
  assert.deepEqual(
    merged.map((h) => h.path),
    ["/b", "/c"],
  );
});
