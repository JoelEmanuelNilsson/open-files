import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFsearchQueries, parseRoots } from "./fsearch-queries.ts";
import type { SearchType } from "./parse-search-query.ts";

const home = "/Users/joel";
const BULK = "!.git$ !node_modules$";
const EXT =
  "ext:png,jpg,jpeg,webp,gif,avif,heic,heif,svg,tif,tiff,bmp,mp4,mov,webm,mkv,m4v,md,mdx,markdown,txt,html,htm,pdf,csv,doc,docx,xls,xlsx,ppt,pptx,key,pages,numbers";

function build(searchType: SearchType, roots: string[], includeDirectories = true, query = "raycast readme") {
  return buildFsearchQueries({ query, searchType }, roots, home, includeDirectories);
}

test("viewable search asks for directories and viewable files in every root, keeping ~/Library out of home", () => {
  assert.deepEqual(build("viewable", [home, "/tmp"]), [
    `in:${home} kind:dir ${BULK} !library$ raycast readme`,
    `in:${home} ${EXT} ${BULK} !library$ raycast readme`,
    `in:/tmp kind:dir ${BULK} raycast readme`,
    `in:/tmp ${EXT} ${BULK} raycast readme`,
  ]);
});

test("parseRoots drops empty tokens and normalizes trailing slashes", () => {
  assert.deepEqual(parseRoots("  /a//  //  /b/ \t/ "), ["/a", "/", "/b", "/"]);
  assert.deepEqual(parseRoots("   "), []);
  assert.deepEqual(parseRoots(""), []);
});

test("home given as a parsed root still excludes ~/Library", () => {
  assert.deepEqual(build("directory", parseRoots(`${home}/ /Applications/`)), [
    `in:${home} kind:dir ${BULK} !library$ raycast readme`,
    `in:/Applications kind:dir ${BULK} raycast readme`,
  ]);
});

test("everything at / has no scope and no Library exclusion", () => {
  assert.deepEqual(build("everything", ["/"]), [`${BULK} raycast readme`]);
});

test("file search and viewable search without directories use only the extension query", () => {
  assert.deepEqual(build("file", ["/tmp"]), [`in:/tmp ${EXT} ${BULK} raycast readme`]);
  assert.deepEqual(build("viewable", ["/tmp"], false), [`in:/tmp ${EXT} ${BULK} raycast readme`]);
});

test("without directories, everything search asks for files only", () => {
  assert.deepEqual(build("everything", ["/tmp"], false), [`in:/tmp kind:file ${BULK} raycast readme`]);
});

test("a -d directive still searches directories when the directories preference is off", () => {
  assert.deepEqual(build("directory", ["/tmp"], false), [`in:/tmp kind:dir ${BULK} raycast readme`]);
});
