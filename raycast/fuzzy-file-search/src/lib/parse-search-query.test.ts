import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchQuery } from "./parse-search-query.ts";

test("parseSearchQuery picks the index type from directives and strips them from the query", () => {
  const cases = [
    ["warship-stern.png", "viewable", "warship-stern.png"],
    ["sat -d", "directory", "sat"],
    ["sat -f", "file", "sat"],
    ["main.ts -a", "everything", "main.ts"],
    ["-all main.ts", "everything", "main.ts"],
  ] as const;
  for (const [searchText, searchType, query] of cases) {
    assert.deepEqual(parseSearchQuery(searchText, "/Users/joel"), {
      query,
      searchType,
      hasDirectives: searchType !== "viewable",
      terms: query.split(" "),
    });
  }
});

test("parseSearchQuery keeps only literal terms: no negations, filters or anchors", () => {
  const { query, terms } = parseSearchQuery("ext:pdf !draft 'exact ^pre foo$ report", "/Users/joel");
  assert.equal(query, "ext:pdf !draft 'exact ^pre foo$ report");
  assert.deepEqual(terms, ["exact", "pre", "foo", "report"]);
});

test("parseSearchQuery expands only a leading ~ or ~/ per token", () => {
  const { query } = parseSearchQuery("~ ~/x ~$doc.docx file~ a~b", "/Users/joel");
  assert.equal(query, "/Users/joel /Users/joel/x ~$doc.docx file~ a~b");
});
